/*
 * This file is part of OpenModelica.
 *
 * Copyright (c) 1998-2026, Open Source Modelica Consortium (OSMC),
 * c/o Linköpings universitet, Department of Computer and Information Science,
 * SE-58183 Linköping, Sweden.
 *
 * All rights reserved.
 *
 * THIS PROGRAM IS PROVIDED UNDER THE TERMS OF AGPL VERSION 3 LICENSE OR
 * THIS OSMC PUBLIC LICENSE (OSMC-PL) VERSION 1.8.
 * ANY USE, REPRODUCTION OR DISTRIBUTION OF THIS PROGRAM CONSTITUTES
 * RECIPIENT'S ACCEPTANCE OF THE OSMC PUBLIC LICENSE OR THE GNU AGPL
 * VERSION 3, ACCORDING TO RECIPIENTS CHOICE.
 *
 * The OpenModelica software and the OSMC (Open Source Modelica Consortium)
 * Public License (OSMC-PL) are obtained from OSMC, either from the above
 * address, from the URLs:
 * http://www.openmodelica.org or
 * https://github.com/OpenModelica/ or
 * http://www.ida.liu.se/projects/OpenModelica,
 * and in the OpenModelica distribution.
 *
 * GNU AGPL version 3 is obtained from:
 * https://www.gnu.org/licenses/licenses.html#GPL
 *
 * This program is distributed WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE, EXCEPT AS EXPRESSLY SET FORTH
 * IN THE BY RECIPIENT SELECTED SUBSIDIARY LICENSE CONDITIONS OF OSMC-PL.
 *
 * See the full OSMC Public License conditions for more details.
 *
 */

/* -----------------------------------------------------------------------------
 * Taken from MockRuntime, the example debugger extension code by Microsoft.
 * -----------------------------------------------------------------------------
 */
/*
 * Implements the Debug Adapter that "adapts" or translates the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 * into requests and events of the real "execution engine" or "debugger".
 */

import {
  LoggingDebugSession,
  InitializedEvent, TerminatedEvent,
  Thread, StackFrame, Source,
  Scope
  /* , BreakpointEvent, OutputEvent,
  ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
  Scope, Handles, Breakpoint, MemoryEvent */
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { GDBAdapter, GDBCommandFlag } from './gdb/gdbAdapter';
import { BreakpointHandler } from './breakpoints/breakpoints';
import * as CommandFactory from './gdb/commandFactory';
import { setLogLevel, logger, LOG_LEVELS } from '../util/logger';
import * as fs from 'fs';
import * as path from 'path';
import type { GDBMIResultRecord, GDBMITuple } from './parser/gdbParser';

/**
 * This interface describes the MetaModelica specific launch attributes (which
 * are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json under
 * "debuggers.configurationAttributes". The interface should always match this
 * schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  /** Absolute path to GDB executable */
  gdb: string;
  /** Absolute path to OpenModelica Compiler executable omc */
  program: string;
  /** Arguments to omc */
  arguments: string[];
  /** Absolute path to the working directory of the program being debugged */
  cwd: string;
  /** logging for the Debug Adapter Protocol */
  logLevel?: string;
  /** Show generated C temporaries in addition to MetaModelica locals. */
  showRuntimeLocals?: boolean;
  /** GDB print elements limit. 0 means unlimited. */
  printElements?: number;
  /** Additional raw GDB setup commands. */
  setupCommands?: string[];
  /** Try conventional toString/listToString functions in the Variables view. */
  autoPrettyPrint?: boolean;
  /** Maximum Variables-view pretty preview length. */
  autoPrettyMaxLength?: number;
  /** Maximum direct collection size for automatic Variables-view pretty previews. */
  autoPrettyMaxCollectionLength?: number;
  /** Maximum automatic pretty preview attempts per Variables request. */
  autoPrettyMaxPerRequest?: number;
  /** Maximum lazy Variables-view pretty output length. */
  lazyPrettyMaxLength?: number;
  /** Maximum indexed list/array/tuple children shown per expansion. */
  maxIndexedChildren?: number;
}

type MetaKind = "locals" | "record" | "list" | "option" | "tuple" | "array" | "pretty" | "synthetic";
type StructuralMetaKind = Exclude<MetaKind, "locals" | "pretty" | "synthetic">;
type ContainerKind = "unorderedSet" | "unorderedMap" | "vector" | "expandableArray" | "doubleEndedList";
type SyntheticKind = "indexedElements" | "mapEntries" | "mapEntry" | "pointerValue";

interface VariableReference {
  kind: MetaKind;
  threadId: number;
  frame: number;
  expression?: string;
  metaType?: string;
  syntheticKind?: SyntheticKind;
  keyExpression?: string;
  keyMetaType?: string;
  valueExpression?: string;
  valueMetaType?: string;
  countLabel?: string;
}

interface GDBVariableInfo {
  name: string;
  type: string;
  value: string;
}

interface LocalResolution {
  byName: Map<string, GDBVariableInfo>;
  sourceToGenerated: Map<string, string>;
}

type MetaModelicaIndexHelper = "mmc_gdb_arrayGet" | "mmc_gdb_listGet";

interface AutoPrettyBudget {
  remaining: number;
}

interface FormatVariableOptions {
  autoPrettyBudget?: AutoPrettyBudget;
}

interface ContainerSummaryEntry {
  name: string;
  type: "Integer";
  expression: string;
}

interface ContainerSummaryValue {
  name: string;
  type: "Integer";
  value: string;
}

const META_KIND_ID: Record<StructuralMetaKind, string> = {
  record: "0",
  list: "1",
  option: "2",
  tuple: "3",
  array: "4"
};

export class MetaModelicaDebugSession extends LoggingDebugSession {
  private gdbAdapter: GDBAdapter;
  private breakpointHandler: BreakpointHandler;
  private selectedThread: number = 1;
  private selectedFrame: number = 0;
  private variableReferences = new Map<number, VariableReference>();
  private nextVariableReference: number = 1000;
  private showRuntimeLocals: boolean = false;
  private printElements: number = 10000;
  private autoPrettyPrint: boolean = false;
  private autoPrettyMaxLength: number = 240;
  private autoPrettyMaxCollectionLength: number = 25;
  private autoPrettyMaxPerRequest: number = 40;
  private lazyPrettyMaxLength: number = 12000;
  private debugConsoleTimeoutMs: number = 15000;
  private maxIndexedChildren: number = 100;
  private generatedFunctionSignatureCache = new Map<string, string[] | undefined>();
  private generatedFunctionSourceDefaultsCache = new Map<string, Map<string, string>>();
  private launchCwd: string = "";
  private launchProgram: string = "";

  public constructor() {
    super();

    this.gdbAdapter = new GDBAdapter();
    this.breakpointHandler = new BreakpointHandler();

    // setup event handlers
    // this._runtime.on('stopOnEntry', () => {
    //   this.sendEvent(new StoppedEvent('entry', MetaModelicaDebugSession.threadID));
    // });
    // this._runtime.on('stopOnStep', () => {
    //   this.sendEvent(new StoppedEvent('step', MetaModelicaDebugSession.threadID));
    // });
    this.gdbAdapter.on('stopOnBreakpoint', (threadID: number) => {
      const stoppedEvent: DebugProtocol.StoppedEvent = {
        type: 'stopped',
        event: 'stopped',
        seq: 0,
        body: {
          reason: 'breakpoint',
          threadId: threadID,
          allThreadsStopped: true
        }
      };
      this.sendEvent(stoppedEvent);
    });
    this.gdbAdapter.on('stopOnStep', (threadID: number) => {
      const stoppedEvent: DebugProtocol.StoppedEvent = {
        type: 'stopped',
        event: 'stopped',
        seq: 0,
        body: {
          reason: 'step',
          threadId: threadID,
          allThreadsStopped: true
        }
      };
      this.sendEvent(stoppedEvent);
    });
    // this._runtime.on('stopOnDataBreakpoint', () => {
    //   this.sendEvent(new StoppedEvent('data breakpoint', MetaModelicaDebugSession.threadID));
    // });
    // this._runtime.on('stopOnInstructionBreakpoint', () => {
    //   this.sendEvent(new StoppedEvent('instruction breakpoint', MetaModelicaDebugSession.threadID));
    // });
    // this._runtime.on('stopOnException', (exception) => {
    //   if (exception) {
    //     this.sendEvent(new StoppedEvent(`exception(${exception})`, MetaModelicaDebugSession.threadID));
    //   } else {
    //     this.sendEvent(new StoppedEvent('exception', MetaModelicaDebugSession.threadID));
    //   }
    // });
    // this._runtime.on('breakpointValidated', (bp: IRuntimeBreakpoint) => {
    //   this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
    // });
    // this._runtime.on('output', (type, text, filePath, line, column) => {

    //   let category: string;
    //   switch(type) {
    //     case 'prio': category = 'important'; break;
    //     case 'out': category = 'stdout'; break;
    //     case 'err': category = 'stderr'; break;
    //     default: category = 'console'; break;
    //   }
    //   const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, category);

    //   if (text === 'start' || text === 'startCollapsed' || text === 'end') {
    //     e.body.group = text;
    //     e.body.output = `group-${text}\n`;
    //   }

    //   e.body.source = this.createSource(filePath);
    //   e.body.line = this.convertDebuggerLineToClient(line);
    //   e.body.column = this.convertDebuggerColumnToClient(column);
    //   this.sendEvent(e);
    // });
    this.gdbAdapter.on('exit', () => {
      this.sendEvent(new TerminatedEvent());
    });
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
    // build and return the capabilities of this debug adapter:
    response.body = response.body || {};

    // the adapter implements the configurationDoneRequest.
    response.body.supportsConfigurationDoneRequest = true;
    // the adapter does not implements the restartRequest so the VSCode is doing the restart by doing a disconnectRequest and then a initializeRequest
    response.body.supportsRestartRequest = false;
    response.body.supportTerminateDebuggee = true;
    response.body.supportsFunctionBreakpoints = true;
    response.body.supportsEvaluateForHovers = true;

    this.sendResponse(response);
  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   */
  protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments) {
    super.configurationDoneRequest(response, args);
    // run the debugged program when configuration is done
    await this.gdbAdapter.sendCommand(CommandFactory.execRun());
  }

  protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request) {
    console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
    this.gdbAdapter.quit();
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    setLogLevel(LOG_LEVELS.includes(args.logLevel as any) ? args.logLevel as typeof LOG_LEVELS[number] : 'warning');
    // start the program in the runtime
    try {
      this.showRuntimeLocals = Boolean(args.showRuntimeLocals);
      this.printElements = typeof args.printElements === "number" && args.printElements >= 0
        ? args.printElements
        : 10000;
      this.autoPrettyPrint = args.autoPrettyPrint === true;
      this.autoPrettyMaxLength = typeof args.autoPrettyMaxLength === "number" && args.autoPrettyMaxLength > 0
        ? args.autoPrettyMaxLength
        : 240;
      this.autoPrettyMaxCollectionLength = typeof args.autoPrettyMaxCollectionLength === "number" && args.autoPrettyMaxCollectionLength > 0
        ? args.autoPrettyMaxCollectionLength
        : 25;
      this.autoPrettyMaxPerRequest = typeof args.autoPrettyMaxPerRequest === "number" && args.autoPrettyMaxPerRequest > 0
        ? args.autoPrettyMaxPerRequest
        : 40;
      this.lazyPrettyMaxLength = typeof args.lazyPrettyMaxLength === "number" && args.lazyPrettyMaxLength > 0
        ? args.lazyPrettyMaxLength
        : 12000;
      this.maxIndexedChildren = typeof args.maxIndexedChildren === "number" && args.maxIndexedChildren > 0
        ? args.maxIndexedChildren
        : 100;
      this.launchCwd = args.cwd;
      this.launchProgram = args.program;
      await this.gdbAdapter.launch(args.program, args.cwd, args.arguments, args.gdb);
      if (this.gdbAdapter.isGDBRunning()) {
        await this.gdbAdapter.setupGDB(this.printElements);
        for (const command of args.setupCommands || []) {
          await this.gdbAdapter.sendCommand(command, GDBCommandFlag.nonCriticalResponse);
        }
        this.sendResponse(response);
      }
      this.sendEvent(new InitializedEvent());
    }
    catch (err) {
      this.sendErrorResponse(response, 1, `Cannot launch program: ${err}`);
    }
  }

  protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
    console.log("setFunctionBreakPointsRequest", this.gdbAdapter.isGDBRunning());
    this.sendResponse(response);
  }

  protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    if (args.source.path) {
      // first remove the breakpoints that belong to the source
      const breakpointNumbers = this.breakpointHandler.getBreakpointIds(args.source.path);
      logger.info(`breakpointNumbers ${breakpointNumbers}`);
      // clear all breakpoints for this file
      if (breakpointNumbers.length > 0) {
        logger.info(`Removing breakpoints ${breakpointNumbers} from source ${args.source.path}`);
        const breakpointNumbersStr = breakpointNumbers.map(String);
        const gdbmiBreakDeleteOutput = await this.gdbAdapter.sendCommand(CommandFactory.breakDelete(breakpointNumbersStr));
        const gdbmiBreakDeleteResultRecord = this.gdbAdapter.getGDBMIResultRecord(gdbmiBreakDeleteOutput);
        if (gdbmiBreakDeleteResultRecord && gdbmiBreakDeleteResultRecord.cls === "done") {
          this.breakpointHandler.deleteBreakpointsByIds(breakpointNumbers);
        }
      }
      // insert new breakpoints
      const breakpoints = args.breakpoints || [];
      for (const bp of breakpoints) {
        logger.info(`Adding breakpoint at line: ${bp.line} at source ${args.source.path}`);
        const gdbmiOutput = await this.gdbAdapter.sendCommand(CommandFactory.breakInsert(args.source.path, bp.line));
        /**
         * If the breakpoint is successfully inserted then we get a result back as,
         *
         * 6^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x00c397f1",
         * func="omc_Interactive_getComponents2",file="c:/OpenModelica/trunk/Compiler/Script/Interactive.mo",
         * fullname="c:\\openmodelica\\trunk\\compiler\\script\\interactive.mo",
         * line="10806",times="0",original-location="C:/OpenModelica/trunk/Compiler/Script/Interactive.mo:10806"}
         *
         * Parse the result and set the breakpoint number which is needed when we have to delete the breakpoint.
         */
        const gdbmiResultRecord = this.gdbAdapter.getGDBMIResultRecord(gdbmiOutput);
        const gdbmiBreakpointResult = gdbmiResultRecord?.miResultsList ? this.gdbAdapter.getGDBMIResult("bkpt", gdbmiResultRecord.miResultsList) : undefined;

        if (gdbmiBreakpointResult && gdbmiBreakpointResult.miValue.miTuple) {
          const gdbmiResult = this.gdbAdapter.getGDBMIResult("number", gdbmiBreakpointResult.miValue.miTuple.miResultsList);
          const breakpointNumber = gdbmiResult ? this.gdbAdapter.getGDBMIConstantValue(gdbmiResult) : "";
          if (breakpointNumber) {
            this.breakpointHandler.addBreakpoint(Number(breakpointNumber), args.source, bp.line);
          }
        }
      }
    }

    // send back breakpoints response
    response.body = {
      breakpoints: this.breakpointHandler.getBreakpoints(args.source)
    };
    this.sendResponse(response);
  }

  // protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

  //   if (args.source.path) {
  //     const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
  //     response.body = {
  //       breakpoints: bps.map(col => {
  //         return {
  //           line: args.line,
  //           column: this.convertDebuggerColumnToClient(col)
  //         };
  //       })
  //     };
  //   } else {
  //     response.body = {
  //       breakpoints: []
  //     };
  //   }
  //   this.sendResponse(response);
  // }

  // protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {

  //   let namedException: string | undefined = undefined;
  //   let otherExceptions = false;

  //   if (args.filterOptions) {
  //     for (const filterOption of args.filterOptions) {
  //       switch (filterOption.filterId) {
  //         case 'namedException':
  //           namedException = args.filterOptions[0].condition;
  //           break;
  //         case 'otherExceptions':
  //           otherExceptions = true;
  //           break;
  //       }
  //     }
  //   }

  //   if (args.filters) {
  //     if (args.filters.indexOf('otherExceptions') >= 0) {
  //       otherExceptions = true;
  //     }
  //   }

  //   this._runtime.setExceptionsFilters(namedException, otherExceptions);

  //   this.sendResponse(response);
  // }

  // protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
  //   response.body = {
  //     exceptionId: 'Exception ID',
  //     description: 'This is a descriptive description of the exception.',
  //     breakMode: 'always',
  //     details: {
  //       message: 'Message contained in the exception.',
  //       typeName: 'Short type name of the exception object',
  //       stackTrace: 'stack frame 1\nstack frame 2',
  //     }
  //   };
  //   this.sendResponse(response);
  // }

  /**
   * Handles the `threadsRequest` from the debug client and retrieves the list of threads
   * currently managed by the GDB debugger. This method communicates with the GDB adapter
   * to fetch thread information and parses the response to construct a list of threads
   * for the debug client.
   *
   * @param response - The `ThreadsResponse` object to be sent back to the debug client.
   *
   */
  protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
    if (this.gdbAdapter.isGDBRunning()) {
      const threads = await this.gdbAdapter.sendCommand(CommandFactory.threadInfo());
      /**
       * -thread-info returns,
       *
       * ^done,threads=[
       * {id="2",target-id="Thread 0xb7e14b90 (LWP 21257)",
       *   frame={level="0",addr="0xffffe410",func="__kernel_vsyscall",
       *     args=[]},state="running"},
       * {id="1",target-id="Thread 0xb7e156b0 (LWP 21254)",
       *   frame={level="0",addr="0x0804891f",func="foo",
       *     args=[{name="i",value="10"}],
       *     file="/tmp/a.c",fullname="/tmp/a.c",line="158"},
       *     state="running"}],
       * current-thread-id="1"
       *
       * Parse the `threads` array to extract thread IDs and target IDs.
       */
      const threadsArray: Thread[] = [];
      const threadsResultRecord = this.gdbAdapter.getGDBMIResultRecord(threads);
      const threadsResult = threadsResultRecord?.miResultsList ? this.gdbAdapter.getGDBMIResult("threads", threadsResultRecord.miResultsList) : undefined;

      if (threadsResult && threadsResult.miValue.miList) {
        threadsResult.miValue.miList.miValuesList.forEach(thread => {
          if (thread.miTuple) {
            const threadIdResult = this.gdbAdapter.getGDBMIResult("id", thread.miTuple.miResultsList);
            const threadId = threadIdResult ? this.gdbAdapter.getGDBMIConstantValue(threadIdResult) : "";
            const targetIdResult = this.gdbAdapter.getGDBMIResult("target-id", thread.miTuple.miResultsList);
            const targetId = targetIdResult ? this.gdbAdapter.getGDBMIConstantValue(targetIdResult) : "";
            const frameResult = this.gdbAdapter.getGDBMIResult("frame", thread.miTuple.miResultsList);
            threadsArray.push(new Thread(Number(threadId), this.threadDisplayName(threadId, targetId, frameResult?.miValue.miTuple)));
          }
        });
      }
      // Send the constructed thread list back to the debug client in the response body.
      response.body = {
        threads: threadsArray
      };
      this.sendResponse(response);
    } else {
      this.sendResponse(response);
    }
  }

  /**
   * Handles the `stackTraceRequest` from the debug client, which retrieves the call stack for a given thread.
   *
   * @param response - The response object to send back to the debug client.
   * @param args - The arguments provided by the debug client, including the thread ID, start frame, and number of levels.
   *
   * The method uses GDB/MI commands like `-stack-info-depth` and `-stack-list-frames` to interact with GDB.
   * The stack frames are parsed from the GDB/MI response and converted into the `StackFrame` format expected by the debug client.
   * The `totalFrames` property in the response body reflects the total stack depth.
   *
   */
  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
    if (this.gdbAdapter.isGDBRunning()) {
      // Determine the current stack depth.
      const stackDepth = await this.gdbAdapter.sendCommand(CommandFactory.stackDepth());
      const stackDepthResultRecord = this.gdbAdapter.getGDBMIResultRecord(stackDepth);
      const stackDepthResult = stackDepthResultRecord?.miResultsList ? this.gdbAdapter.getGDBMIResult("depth", stackDepthResultRecord.miResultsList) : undefined;
      const stackDepthValue = stackDepthResult ? Number(this.gdbAdapter.getGDBMIConstantValue(stackDepthResult)) : 0;

      const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
      const maxLevels = typeof args.levels === 'number' && args.levels > 0 ? args.levels : stackDepthValue;
      const endFrame = Math.max(0, stackDepthValue - 1);
      this.selectedThread = args.threadId;
      // Retrieve the stack frames for the specified thread and range of frames.
      const stack = await this.gdbAdapter.sendCommand(CommandFactory.stackListFrames(args.threadId, 0, endFrame));
      /**
       * -stack-list-frames --thread 1 returns,
       *
       * ^done,stack=
       * [frame={level="0",addr="0x0001076c",func="foo",
       *   file="recursive2.c",fullname="/home/foo/bar/recursive2.c",line="11",
       *   arch="i386:x86_64"},
       * frame={level="1",addr="0x000107a4",func="foo",
       *   file="recursive2.c",fullname="/home/foo/bar/recursive2.c",line="14",
       *   arch="i386:x86_64"},
       * frame={level="2",addr="0x000107a4",func="foo",
       *   file="recursive2.c",fullname="/home/foo/bar/recursive2.c",line="14",
       *   arch="i386:x86_64"}]
       *
       * Parse the GDB/MI response to extract stack frame details such as function name, file, line number, and more.
       */
      const stackFramesArray: StackFrame[] = [];
      const stackResultRecord = this.gdbAdapter.getGDBMIResultRecord(stack);
      const stackResult = stackResultRecord?.miResultsList ? this.gdbAdapter.getGDBMIResult("stack", stackResultRecord.miResultsList) : undefined;

      if (stackResult && stackResult.miValue.miList) {
        stackResult.miValue.miList.miResultsList.forEach(frame => {
          if (frame.miValue.miTuple) {
            const levelResult = this.gdbAdapter.getGDBMIResult("level", frame.miValue.miTuple.miResultsList);
            const level = levelResult ? this.gdbAdapter.getGDBMIConstantValue(levelResult) : "";

            const fileResult = this.gdbAdapter.getGDBMIResult("file", frame.miValue.miTuple.miResultsList);
            const file = fileResult ? this.cleanupFileName(this.gdbAdapter.getGDBMIConstantValue(fileResult)) : "";

            const funcResult = this.gdbAdapter.getGDBMIResult("func", frame.miValue.miTuple.miResultsList);
            const func = funcResult ? this.cleanupFunction(this.gdbAdapter.getGDBMIConstantValue(funcResult), file) : "";

            const fullnameResult = this.gdbAdapter.getGDBMIResult("fullname", frame.miValue.miTuple.miResultsList);
            const fullname = fullnameResult ? this.gdbAdapter.getGDBMIConstantValue(fullnameResult) : "";

            const lineResult = this.gdbAdapter.getGDBMIResult("line", frame.miValue.miTuple.miResultsList);
            const line = lineResult ? Number(this.gdbAdapter.getGDBMIConstantValue(lineResult)) : 0;

            const sourcePath = fullname || file;
            if (!this.isMetaModelicaSource(sourcePath)) {
              return;
            }
            const sourceName = sourcePath ? path.basename(sourcePath) : file;
            const source = sourcePath ? new Source(sourceName, sourcePath) : undefined;
            stackFramesArray.push(new StackFrame(Number(level), func || "<unknown>", source, line));
          }
        });
      }
      const requestedStackFrames = stackFramesArray.slice(startFrame, startFrame + maxLevels);
      // The parsed stack frames are then sent back to the debug client in the response body.
      response.body = {
        stackFrames: requestedStackFrames,
        totalFrames: stackFramesArray.length
      };
      this.sendResponse(response);
    } else {
      this.sendResponse(response);
    }
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    if (this.gdbAdapter.isGDBRunning()) {
      this.selectedFrame = args.frameId;
      const variablesReference = this.makeVariableReference({
        kind: "locals",
        threadId: this.selectedThread,
        frame: args.frameId
      });

      response.body = {
        scopes: [
          new Scope("Locals", variablesReference, false)
        ]
      };
      this.sendResponse(response);
    } else {
      this.sendResponse(response);
    }
  }

  // protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, { data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments) {
  //   const variable = this._variableHandles.get(Number(memoryReference));
  //   if (typeof variable === 'object') {
  //     const decoded = base64.toByteArray(data);
  //     variable.setMemory(decoded, offset);
  //     response.body = { bytesWritten: decoded.length };
  //   } else {
  //     response.body = { bytesWritten: 0 };
  //   }

  //   this.sendResponse(response);
  //   this.sendEvent(new InvalidatedEvent(['variables']));
  // }

  // protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, { offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments) {
  //   const variable = this._variableHandles.get(Number(memoryReference));
  //   if (typeof variable === 'object' && variable.memory) {
  //     const memory = variable.memory.subarray(
  //       Math.min(offset, variable.memory.length),
  //       Math.min(offset + count, variable.memory.length),
  //     );

  //     response.body = {
  //       address: offset.toString(),
  //       data: base64.fromByteArray(memory),
  //       unreadableBytes: count - memory.length
  //     };
  //   } else {
  //     response.body = {
  //       address: offset.toString(),
  //       data: '',
  //       unreadableBytes: count
  //     };
  //   }

  //   this.sendResponse(response);
  // }

  protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
    if (this.gdbAdapter.isGDBRunning()) {
      try {
        const variableReference = this.variableReferences.get(args.variablesReference);
        const variablesArray = variableReference ? await this.getVariables(variableReference) : [];
        response.body = {
          variables: variablesArray
        };
        this.sendResponse(response);
      } catch (error) {
        this.sendErrorResponse(response, 1, `${error}`);
      }
    } else {
      this.sendResponse(response);
    }
  }

  private makeVariableReference(reference: VariableReference): number {
    this.nextVariableReference += 1;
    this.variableReferences.set(this.nextVariableReference, reference);
    return this.nextVariableReference;
  }

  private async getVariables(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    if (reference.kind === "locals") {
      return this.getLocalVariables(reference.threadId, reference.frame);
    }
    if (reference.kind === "pretty") {
      return this.getPrettyChildren(reference);
    }
    if (reference.kind === "synthetic") {
      return this.getSyntheticChildren(reference);
    }
    return this.getMetaChildren(reference);
  }

  private async getLocalVariables(threadId: number, frame: number): Promise<DebugProtocol.Variable[]> {
    const variables = await this.getStackVariables(threadId, frame);
    const result: DebugProtocol.Variable[] = [];
    const options: FormatVariableOptions = {
      autoPrettyBudget: { remaining: this.autoPrettyMaxPerRequest }
    };
    for (const variable of variables) {
      if (!this.showRuntimeLocals && !variable.name.startsWith("_")) {
        continue;
      }
      const displayName = variable.name.startsWith("_") ? variable.name.replace(/^_/, "") : variable.name;
      result.push(await this.formatVariable(threadId, frame, variable.name, displayName, variable.type, variable.value, false, "", options));
    }
    return result;
  }

  private async getStackVariables(threadId: number, frame: number): Promise<GDBVariableInfo[]> {
    const output = await this.gdbAdapter.sendCommand(CommandFactory.stackListVariables(threadId, frame));
    const resultRecord = this.gdbAdapter.getGDBMIResultRecord(output);
    const variablesResult = resultRecord?.miResultsList ? this.gdbAdapter.getGDBMIResult("variables", resultRecord.miResultsList) : undefined;
    const variables: GDBVariableInfo[] = [];

    if (variablesResult?.miValue.miList) {
      for (const variable of variablesResult.miValue.miList.miValuesList) {
        if (!variable.miTuple) {
          continue;
        }
        const nameResult = this.gdbAdapter.getGDBMIResult("name", variable.miTuple.miResultsList);
        const typeResult = this.gdbAdapter.getGDBMIResult("type", variable.miTuple.miResultsList);
        const valueResult = this.gdbAdapter.getGDBMIResult("value", variable.miTuple.miResultsList);
        const name = nameResult ? this.gdbAdapter.getGDBMIConstantValue(nameResult) : "";
        if (!name) {
          continue;
        }
        variables.push({
          name,
          type: typeResult ? this.gdbAdapter.getGDBMIConstantValue(typeResult) : "",
          value: valueResult ? this.gdbAdapter.getGDBMIConstantValue(valueResult) : ""
        });
      }
    }

    return variables;
  }

  private async formatVariable(
    threadId: number,
    frame: number,
    expression: string,
    displayName: string,
    declaredType: string,
    rawValue: string = "",
    inRecord: boolean = false,
    metaChildType: string = "",
    options: FormatVariableOptions = {}
  ): Promise<DebugProtocol.Variable> {
    let displayType = this.displayCType(declaredType);
    let value = rawValue;
    let variablesReference = 0;

    if (metaChildType) {
      displayType = metaChildType;
      if (metaChildType === "String") {
        value = await this.anyString(threadId, frame, expression);
      } else if (metaChildType === "Integer") {
        value = expression;
      } else if (["Boolean", "Real"].includes(metaChildType)) {
        value = await this.anyString(threadId, frame, expression);
        if (metaChildType === "Boolean") {
          value = value.startsWith("1") ? "true" : value.startsWith("0") ? "false" : value;
        }
      } else {
        const metaExpression = this.metaValueExpression(expression);
        value = await this.describeMetaValue(threadId, frame, metaExpression, metaChildType, options);
        variablesReference = this.referenceForMeta(threadId, frame, metaExpression, metaChildType);
      }
    } else if (this.isMetaType(declaredType)) {
      try {
        const metaExpression = this.looksLikePointerValue(rawValue)
          ? this.forceMetaValueExpression(expression)
          : this.metaValueExpression(expression);
        const metaType = await this.getTypeOfAny(threadId, frame, metaExpression, inRecord);
        displayType = metaType || displayType;
        if (["String", "Integer", "Boolean", "Real"].includes(metaType)) {
          value = await this.anyString(threadId, frame, metaExpression);
        } else if (metaType) {
          value = await this.describeMetaValue(threadId, frame, metaExpression, metaType, options);
          variablesReference = this.referenceForMeta(threadId, frame, metaExpression, metaType);
        } else if (!value) {
          value = "<unavailable>";
        }
      } catch {
        value = rawValue || "<unavailable>";
      }
    }

    if (!variablesReference && displayType === "Boolean") {
      value = rawValue.startsWith("1") ? "true" : rawValue.startsWith("0") ? "false" : rawValue;
    }

    return {
      name: displayName,
      value,
      type: displayType,
      variablesReference,
      evaluateName: variablesReference ? this.metaValueExpression(expression) : expression
    };
  }

  private async tryFormatPotentialMetaValue(
    threadId: number,
    frame: number,
    expression: string,
    forcePretty: boolean,
    options: FormatVariableOptions = {}
  ): Promise<DebugProtocol.EvaluateResponse["body"] | undefined> {
    try {
      const metaExpression = this.forceMetaValueExpression(expression);
      const metaType = await this.getTypeOfAny(threadId, frame, metaExpression, false);
      if (!metaType || !this.isUsefulMetaRuntimeType(metaType)) {
        return undefined;
      }

      if (["String", "Integer", "Boolean", "Real"].includes(metaType)) {
        return {
          result: await this.anyString(threadId, frame, metaExpression),
          type: metaType,
          variablesReference: 0
        };
      }

      const pretty = await this.conventionalPrettyValue(threadId, frame, metaExpression, metaType, forcePretty, options.autoPrettyBudget);
      return {
        result: pretty || await this.describeMetaValue(threadId, frame, metaExpression, metaType, options),
        type: metaType,
        variablesReference: this.referenceForMeta(threadId, frame, metaExpression, metaType)
      };
    } catch {
      return undefined;
    }
  }

  private isUsefulMetaRuntimeType(metaType: string): boolean {
    if (["String", "Real"].includes(metaType)) {
      return true;
    }
    if (["Integer", "Boolean"].includes(metaType)) {
      return false;
    }
    return Boolean(this.metaKind(metaType));
  }

  private async getMetaChildren(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    if (!reference.expression || !reference.metaType || reference.kind === "locals" || reference.kind === "pretty" || reference.kind === "synthetic") {
      return [];
    }

    let count = 0;
    let start = 1;
    const result: DebugProtocol.Variable[] = [];
    const options: FormatVariableOptions = {
      autoPrettyBudget: { remaining: this.autoPrettyMaxPerRequest }
    };
    const pretty = await this.lazyPrettyVariable(reference);
    if (pretty) {
      result.push(pretty);
    }
    if (reference.kind === "record") {
      result.push(...await this.containerSummaryVariables(reference));
      result.push(...await this.containerSyntheticVariables(reference, options));
      result.push(...await this.pointerSyntheticVariables(reference, options));
    }
    if (reference.kind === "option") {
      const isNone = await this.isOptionNone(reference.threadId, reference.frame, reference.expression);
      if (isNone) {
        return [];
      }
      count = 1;
    } else if (reference.kind === "list") {
      count = await this.listLength(reference.threadId, reference.frame, reference.expression);
      if (count > 0) {
        const headExpression = this.listHeadExpression(reference.expression);
        result.push(await this.formatVariable(
          reference.threadId,
          reference.frame,
          headExpression,
          "head",
          "modelica_metatype",
          "",
          false,
          "",
          options
        ));

        const tailExpression = this.listTailExpression(reference.expression);
        const tail = await this.formatVariable(
          reference.threadId,
          reference.frame,
          tailExpression,
          "tail",
          "modelica_metatype",
          "",
          false,
          reference.metaType,
          options
        );
        tail.variablesReference = count > 1 ? tail.variablesReference : 0;
        result.push(tail);
      }
    } else {
      count = await this.arrayLength(reference.threadId, reference.frame, reference.expression);
      start = reference.kind === "record" ? 2 : 1;
    }

    const indexedCount = reference.kind === "record" ? count : Math.min(count, this.maxIndexedChildren);
    for (let i = start; i <= indexedCount; i++) {
      if (reference.kind === "array") {
        result.push(await this.formatVariable(
          reference.threadId,
          reference.frame,
          this.arrayElementExpression(reference.expression, i),
          `[${i}]`,
          "modelica_metatype",
          "",
          false,
          "",
          options
        ));
        continue;
      }

      const metaKindId = META_KIND_ID[reference.kind];
      const child = await this.getMetaElement(reference.threadId, reference.frame, reference.expression, i, metaKindId);
      if (!child.name) {
        continue;
      }
      const displayName = child.displayName && child.displayName !== "(null)" ? child.displayName : `[${i}]`;
      result.push(await this.formatVariable(
        reference.threadId,
        reference.frame,
        child.name,
        displayName,
        "modelica_metatype",
        "",
        reference.kind === "record",
        child.type,
        options
      ));
    }
    if (indexedCount < count) {
      result.push(this.truncatedChildrenVariable(count - indexedCount, reference.kind === "list" ? "list cells" : "elements"));
    }
    return result;
  }

  private truncatedChildrenVariable(remaining: number, label: string): DebugProtocol.Variable {
    return {
      name: "[...]",
      value: `${remaining} more ${label} not shown`,
      type: "MetaModelica",
      variablesReference: 0
    };
  }

  private async lazyPrettyVariable(reference: VariableReference): Promise<DebugProtocol.Variable | undefined> {
    if (!reference.expression || !reference.metaType) {
      return undefined;
    }

    const prettyFunctions = this.conventionalPrettyFunctionNamesForValue(reference.metaType);
    if (prettyFunctions.length === 0) {
      return undefined;
    }

    return {
      name: "[pretty]",
      value: `expand to compute ${this.prettyFunctionNameLabel(prettyFunctions[0])}`,
      type: "String",
      variablesReference: this.makeVariableReference({
        kind: "pretty",
        threadId: reference.threadId,
        frame: reference.frame,
        expression: reference.expression,
        metaType: reference.metaType
      }),
      evaluateName: reference.expression
    };
  }

  private async getPrettyChildren(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    if (!reference.expression || !reference.metaType) {
      return [];
    }

    try {
      return this.prettyStringToVariables(await this.lazyPrettyValue(reference.threadId, reference.frame, reference.expression, reference.metaType));
    } catch (error) {
      return [{
        name: "error",
        value: `${error}`,
        type: "Error",
        variablesReference: 0
      }];
    }
  }

  private async lazyPrettyValue(threadId: number, frame: number, expression: string, metaType: string): Promise<string> {
    const printLimit = Math.max(this.lazyPrettyMaxLength + 32, 80);
    const failures: string[] = [];
    for (const prettyCall of await this.conventionalPrettyCallsForValue(threadId, frame, expression, metaType)) {
      try {
        const value = await this.withPrintElements(printLimit, () => this.evaluateStringExpressionWithTimeout(threadId, frame, prettyCall));
        return this.truncatePrettyValue(value, this.lazyPrettyMaxLength);
      } catch (error) {
        failures.push(`${prettyCall}: ${this.shortError(error)}`);
        // Try the next conventional spelling.
      }
    }
    if (failures.length > 0) {
      throw new Error(`Conventional pretty-printer failed:\n${failures.join("\n")}`);
    }
    throw new Error("No conventional MetaModelica pretty-printer is available for this value.");
  }

  private prettyStringToVariables(value: string): DebugProtocol.Variable[] {
    if (!value) {
      return [{
        name: "value",
        value: "<empty>",
        type: "String",
        variablesReference: 0
      }];
    }

    const maxLineLength = 1000;
    const maxLines = 200;
    const lines = value.split(/\r?\n/);
    if (lines.length === 1) {
      const chunks = this.chunkString(lines[0], maxLineLength);
      return chunks.map((chunk, index) => ({
        name: chunks.length === 1 ? "value" : `[${index + 1}]`,
        value: chunk,
        type: "String",
        variablesReference: 0
      }));
    }

    const result: DebugProtocol.Variable[] = [];
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      result.push({
        name: `[${i + 1}]`,
        value: this.truncateSingleLine(lines[i], maxLineLength),
        type: "String",
        variablesReference: 0
      });
    }
    if (lines.length > maxLines) {
      result.push({
        name: "[...]",
        value: `${lines.length - maxLines} more lines not shown`,
        type: "String",
        variablesReference: 0
      });
    }
    return result;
  }

  private chunkString(value: string, chunkLength: number): string[] {
    const result: string[] = [];
    for (let i = 0; i < value.length; i += chunkLength) {
      result.push(value.slice(i, i + chunkLength));
    }
    return result.length ? result : [""];
  }

  private truncateSingleLine(value: string, maxLength: number): string {
    const compact = value.replace(/\r?\n/g, "\\n");
    if (compact.length <= maxLength) {
      return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  private async describeMetaValue(threadId: number, frame: number, expression: string, metaType: string, options: FormatVariableOptions = {}): Promise<string> {
    const kind = this.metaKind(metaType);
    try {
      const pretty = await this.conventionalPrettyValue(threadId, frame, expression, metaType, false, options.autoPrettyBudget);
      if (pretty) {
        return pretty;
      }

      if (kind === "list") {
        const count = await this.safeListLength(threadId, frame, expression);
        return count === undefined ? `${metaType} (size unknown)` : `${metaType} (${this.itemCount(count)})`;
      }
      if (kind === "array") {
        const count = await this.safeArrayLength(threadId, frame, expression);
        return count === undefined ? `${metaType} (size unknown)` : `${metaType} (${this.itemCount(count)})`;
      }
      if (kind === "record") {
        const containerLabel = await this.containerInlineLabel(threadId, frame, expression, metaType);
        if (containerLabel) {
          return containerLabel;
        }
        const slots = await this.safeArrayLength(threadId, frame, expression);
        const fields = slots === undefined ? undefined : Math.max(0, slots - 1);
        return fields === undefined ? `${metaType} (fields unknown)` : `${metaType} (${this.fieldCount(fields)})`;
      }
      if (kind === "tuple") {
        const count = await this.safeArrayLength(threadId, frame, expression);
        return count === undefined ? `${metaType} (size unknown)` : `${metaType} (${this.elementCount(count)})`;
      }
      if (kind === "option") {
        const isNone = await this.isOptionNone(threadId, frame, expression);
        return `${metaType} (${isNone ? "NONE" : "SOME"})`;
      }
    } catch {
      return metaType;
    }
    return metaType;
  }

  private async conventionalPrettyValue(threadId: number, frame: number, expression: string, metaType: string, force: boolean = false, budget?: AutoPrettyBudget): Promise<string | undefined> {
    if (!force && !this.autoPrettyPrint) {
      return undefined;
    }

    const calls = await this.conventionalPrettyCallsForValue(threadId, frame, expression, metaType);
    if (calls.length === 0) {
      return undefined;
    }

    if (!force) {
      if (budget && budget.remaining <= 0) {
        return undefined;
      }
      if (!await this.isAutoPrettyPreviewAllowed(threadId, frame, expression, metaType)) {
        return undefined;
      }
      if (budget) {
        budget.remaining -= 1;
      }
    }

    const printLimit = force ? undefined : Math.max(this.autoPrettyMaxLength + 32, 80);
    const failures: string[] = [];
    for (const prettyCall of calls) {
      try {
        const value = typeof printLimit === "number"
          ? await this.withPrintElements(printLimit, () => this.evaluateStringExpressionWithTimeout(threadId, frame, prettyCall))
          : await this.evaluateStringExpressionWithTimeout(threadId, frame, prettyCall);
        const displayValue = force ? value : this.previewPrettyValue(value);
        if (displayValue !== undefined) {
          return displayValue;
        }
      } catch (error) {
        failures.push(`${prettyCall}: ${this.shortError(error)}`);
        // Not every record module has a simple toString(value) convention.
      }
    }

    if (force && failures.length > 0) {
      return `Conventional pretty-printer failed:\n${failures.join("\n")}`;
    }
    return undefined;
  }

  private async isAutoPrettyPreviewAllowed(threadId: number, frame: number, expression: string, metaType: string): Promise<boolean> {
    const kind = this.metaKind(metaType);
    if (kind === "list") {
      const count = await this.listLength(threadId, frame, expression);
      return Number.isFinite(count) && count <= this.autoPrettyMaxCollectionLength;
    }
    if (kind === "array" || kind === "tuple") {
      const count = await this.arrayLength(threadId, frame, expression);
      return Number.isFinite(count) && count <= this.autoPrettyMaxCollectionLength;
    }
    return true;
  }

  private async safeListLength(threadId: number, frame: number, expression: string): Promise<number | undefined> {
    try {
      const count = await this.listLength(threadId, frame, expression);
      return Number.isFinite(count) ? count : undefined;
    } catch {
      return undefined;
    }
  }

  private async safeArrayLength(threadId: number, frame: number, expression: string): Promise<number | undefined> {
    try {
      const count = await this.arrayLength(threadId, frame, expression);
      return Number.isFinite(count) ? count : undefined;
    } catch {
      return undefined;
    }
  }

  private itemCount(count: number): string {
    return `${count} ${count === 1 ? "item" : "items"}`;
  }

  private elementCount(count: number): string {
    return `${count} ${count === 1 ? "element" : "elements"}`;
  }

  private fieldCount(count: number): string {
    return `${count} ${count === 1 ? "field" : "fields"}`;
  }

  private async conventionalPrettyCallsForValue(threadId: number, frame: number, expression: string, metaType: string): Promise<string[]> {
    const calls: string[] = [];
    for (const generatedName of this.conventionalPrettyFunctionNamesForValue(metaType)) {
      const call = await this.guardedGeneratedPrettyCall(threadId, frame, generatedName, expression);
      if (call) {
        calls.push(call);
      } else {
        calls.push(`${generatedName}(threadData, ${this.metaValueExpression(expression)})`);
      }
    }
    return calls;
  }

  private conventionalPrettyFunctionNamesForValue(metaType: string): string[] {
    const listModule = this.recordModuleFromListType(metaType);
    if (listModule) {
      return [`omc_${listModule}_listToString`, `omc_${listModule}_toStringList`];
    }

    const recordModule = this.recordModuleFromType(metaType);
    return recordModule ? [`omc_${recordModule}_toString`] : [];
  }

  private async guardedGeneratedPrettyCall(threadId: number, frame: number, generatedName: string, expression: string): Promise<string | undefined> {
    const params = await this.generatedFunctionSignature(threadId, frame, generatedName);
    if (!params || params.length < 2) {
      return undefined;
    }

    const valueExpression = this.metaValueExpression(expression);
    const args = await this.addDefaultMetaModelicaCallArguments(threadId, frame, generatedName, [valueExpression]);
    if (params.length !== args.length + 1) {
      return undefined;
    }

    return `${generatedName}(threadData, ${args.join(", ")})`;
  }

  private prettyFunctionNameLabel(generatedName: string): string {
    const match = /^omc_([A-Za-z0-9_]+)_([A-Za-z0-9_]+)$/.exec(generatedName);
    if (!match) {
      return "pretty-printer";
    }
    return `${match[1].replace(/_/g, ".")}.${match[2]}`;
  }

  private recordQualifiedNameFromType(metaType: string): string | undefined {
    const match = /^record<([\s\S]+)>$/i.exec(metaType.trim());
    return match ? this.stripTypeArguments(match[1].trim()) : undefined;
  }

  private recordQualifiedNameFromListType(metaType: string): string | undefined {
    const elementType = this.singleTypeArgument(metaType.trim(), "list");
    if (!elementType) {
      return undefined;
    }

    const recordName = this.recordQualifiedNameFromType(elementType);
    if (recordName) {
      return recordName;
    }

    // Some debug helpers report aliases as list<NFComponentRef.ComponentRef>
    // instead of list<record<NFComponentRef.CREF>>.  The module part is still
    // enough to try the conventional Module.listToString function lazily.
    return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(elementType)
      ? elementType
      : undefined;
  }

  private stripTypeArguments(typeName: string): string {
    const open = typeName.indexOf("<");
    return open >= 0 ? typeName.slice(0, open).trim() : typeName.trim();
  }

  private recordModuleFromListType(metaType: string): string | undefined {
    const qualifiedRecord = this.recordQualifiedNameFromListType(metaType);
    return qualifiedRecord ? this.moduleNameFromQualifiedRecord(qualifiedRecord) : undefined;
  }

  private recordModuleFromType(metaType: string): string | undefined {
    const qualifiedRecord = this.recordQualifiedNameFromType(metaType);
    return qualifiedRecord ? this.moduleNameFromQualifiedRecord(qualifiedRecord) : undefined;
  }

  private moduleNameFromQualifiedRecord(qualifiedRecord: string): string | undefined {
    if (!qualifiedRecord) {
      return undefined;
    }
    const parts = qualifiedRecord.split(".");
    if (parts.length < 2) {
      return undefined;
    }
    parts.pop();
    return parts.join("_");
  }

  private singleTypeArgument(metaType: string, typeName: string): string | undefined {
    const prefix = `${typeName}<`;
    if (!metaType.toLowerCase().startsWith(prefix.toLowerCase()) || !metaType.endsWith(">")) {
      return undefined;
    }

    const inner = metaType.slice(prefix.length, -1).trim();
    let depth = 0;
    for (const ch of inner) {
      if (ch === "<") {
        depth += 1;
      } else if (ch === ">") {
        depth -= 1;
        if (depth < 0) {
          return undefined;
        }
      } else if (ch === "," && depth === 0) {
        return undefined;
      }
    }
    return depth === 0 && inner ? inner : undefined;
  }

  private async generatedFunctionSignature(threadId: number, frame: number, generatedName: string): Promise<string[] | undefined> {
    if (this.generatedFunctionSignatureCache.has(generatedName)) {
      return this.generatedFunctionSignatureCache.get(generatedName);
    }

    try {
      await this.gdbAdapter.sendCommand(CommandFactory.threadSelect(threadId), GDBCommandFlag.nonCriticalResponse);
      await this.gdbAdapter.sendCommand(CommandFactory.stackSelectFrame(frame), GDBCommandFlag.nonCriticalResponse);
      const output = await this.gdbAdapter.sendCommand(`-interpreter-exec console ${CommandFactory.miQuote(`ptype ${generatedName}`)}`);
      const text = this.gdbConsoleOutput(output);
      const params = this.parseGDBFunctionParameters(text);
      this.generatedFunctionSignatureCache.set(generatedName, params);
      return params;
    } catch {
      const params = this.generatedFunctionSignatureFromGeneratedHeader(generatedName);
      this.generatedFunctionSignatureCache.set(generatedName, params);
      return params;
    }
  }

  private generatedFunctionSignatureFromGeneratedHeader(generatedName: string): string[] | undefined {
    const moduleName = this.generatedFunctionModuleName(generatedName);
    if (!moduleName) {
      return undefined;
    }

    for (const headerPath of this.generatedHeaderCandidates(moduleName)) {
      try {
        const text = fs.readFileSync(headerPath, "utf8");
        const escaped = this.escapeRegExp(generatedName);
        const match = new RegExp(`(?:DLLDirection\\s+)?[A-Za-z_][A-Za-z0-9_\\s\\*]*\\s+${escaped}\\s*\\(([\\s\\S]*?)\\)\\s*;`).exec(text);
        if (match) {
          return this.splitTopLevelArgs(match[1]).map(param => param.trim()).filter(Boolean);
        }
      } catch {
        // Try the next candidate path.
      }
    }

    return undefined;
  }

  private generatedHeaderCandidates(moduleName: string): string[] {
    const roots = this.openModelicaRootCandidates();
    const relativeCandidates = [
      path.join("build_cmake", "OMCompiler", "Compiler", "c_files", `${moduleName}.h`),
      path.join("OMCompiler", "Compiler", "boot", "bootstrap-sources", "build", `${moduleName}.h`)
    ];
    return roots.flatMap(root => relativeCandidates.map(candidate => path.join(root, candidate)));
  }

  private openModelicaRootCandidates(): string[] {
    const roots = new Set<string>();
    if (this.launchCwd) {
      roots.add(this.launchCwd);
    }
    if (this.launchProgram) {
      let dir = path.dirname(this.launchProgram);
      for (let i = 0; i < 8; i++) {
        roots.add(dir);
        dir = path.dirname(dir);
      }
    }
    return [...roots];
  }

  private generatedFunctionModuleName(generatedName: string): string | undefined {
    const match = /^omc_([A-Za-z0-9_]+?)(?:_[A-Za-z0-9]+)?$/.exec(generatedName);
    if (!match) {
      return undefined;
    }

    const parts = generatedName.slice(4).split("_");
    return parts.length > 1 ? parts[0] : undefined;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private gdbConsoleOutput(output: import("./parser/gdbParser").GDBMIOutput): string {
    const chunks: string[] = [];
    if (output.miResultRecord?.consoleStreamOutput) {
      chunks.push(this.stripGDBCString(output.miResultRecord.consoleStreamOutput));
    }
    if (output.miResultRecord?.logStreamOutput) {
      chunks.push(this.stripGDBCString(output.miResultRecord.logStreamOutput));
    }
    for (const record of output.miOutOfBandRecordList) {
      if (record.miStreamRecord?.value) {
        chunks.push(this.stripGDBCString(record.miStreamRecord.value));
      }
    }
    return chunks.join("");
  }

  private parseGDBFunctionParameters(text: string): string[] | undefined {
    const normalized = text.replace(/\\n/g, "\n").replace(/\s+/g, " ").trim();
    const open = normalized.indexOf("(");
    const close = normalized.lastIndexOf(")");
    if (open < 0 || close < open) {
      return undefined;
    }
    const paramsText = normalized.slice(open + 1, close).trim();
    if (!paramsText || paramsText === "void") {
      return [];
    }
    return this.splitTopLevelArgs(paramsText).map(param => param.trim()).filter(Boolean);
  }

  private isModelicaStringParameter(param: string): boolean {
    return /\b(modelica_string|metamodelica_string|const char\s*\*)\b/.test(param);
  }

  private isModelicaMetatypeParameter(param: string): boolean {
    return /\b(modelica_metatype|void\s*\*)\b/.test(param);
  }

  private isModelicaBooleanParameter(param: string): boolean {
    return /\b(modelica_boolean|_Bool|bool)\b/.test(param);
  }

  private containerKind(metaType: string): ContainerKind | "" {
    switch (this.recordQualifiedNameFromType(metaType)) {
      case "UnorderedSet.UNORDERED_SET":
        return "unorderedSet";
      case "UnorderedMap.UNORDERED_MAP":
        return "unorderedMap";
      case "Vector.VECTOR":
        return "vector";
      case "ExpandableArray.EXPANDABLE_ARRAY":
        return "expandableArray";
      case "DoubleEnded.MutableList.LIST":
        return "doubleEndedList";
      default:
        return "";
    }
  }

  private isPointerRecord(metaType: string): boolean {
    const qualifiedRecord = this.recordQualifiedNameFromType(metaType);
    return Boolean(qualifiedRecord && qualifiedRecord.split(".")[0] === "Pointer");
  }

  private containerSummaryEntries(expression: string, metaType: string): ContainerSummaryEntry[] {
    const valueExpression = this.metaValueExpression(expression);
    switch (this.containerKind(metaType)) {
      case "unorderedSet":
        return [
          { name: "size", type: "Integer", expression: `(modelica_integer)omc_UnorderedSet_size(threadData, ${valueExpression})` },
          { name: "buckets", type: "Integer", expression: `(modelica_integer)omc_UnorderedSet_bucketCount(threadData, ${valueExpression})` }
        ];
      case "unorderedMap":
        return [
          { name: "size", type: "Integer", expression: `(modelica_integer)omc_UnorderedMap_size(threadData, ${valueExpression})` },
          { name: "buckets", type: "Integer", expression: `(modelica_integer)omc_UnorderedMap_bucketCount(threadData, ${valueExpression})` }
        ];
      case "vector":
        return [
          { name: "size", type: "Integer", expression: `(modelica_integer)omc_Vector_size(threadData, ${valueExpression})` },
          { name: "capacity", type: "Integer", expression: `(modelica_integer)omc_Vector_capacity(threadData, ${valueExpression})` }
        ];
      case "expandableArray":
        return [
          { name: "elements", type: "Integer", expression: `(modelica_integer)omc_ExpandableArray_getNumberOfElements(threadData, ${valueExpression})` },
          { name: "last used", type: "Integer", expression: `(modelica_integer)omc_ExpandableArray_getLastUsedIndex(threadData, ${valueExpression})` },
          { name: "capacity", type: "Integer", expression: `(modelica_integer)omc_ExpandableArray_getCapacity(threadData, ${valueExpression})` }
        ];
      case "doubleEndedList":
        return [
          { name: "length", type: "Integer", expression: `(modelica_integer)omc_DoubleEnded_length(threadData, ${valueExpression})` }
        ];
      default:
        return [];
    }
  }

  private async containerSummaryValues(threadId: number, frame: number, expression: string, metaType: string): Promise<ContainerSummaryValue[]> {
    const values: ContainerSummaryValue[] = [];
    for (const entry of this.containerSummaryEntries(expression, metaType)) {
      const value = await this.evaluateScalarExpression(threadId, frame, entry.expression);
      if (value !== undefined) {
        values.push({ name: entry.name, type: entry.type, value });
      }
    }
    return values;
  }

  private async containerInlineLabel(threadId: number, frame: number, expression: string, metaType: string): Promise<string | undefined> {
    const staticLabel = this.containerStaticLabel(metaType);
    if (!staticLabel) {
      return undefined;
    }

    const values = await this.containerSummaryValues(threadId, frame, expression, metaType);
    if (values.length === 0) {
      return staticLabel;
    }

    return `${staticLabel} (${values.map(value => `${value.name}=${value.value}`).join(", ")})`;
  }

  private async containerSummaryVariables(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    if (!reference.expression || !reference.metaType) {
      return [];
    }

    const values = await this.containerSummaryValues(reference.threadId, reference.frame, reference.expression, reference.metaType);
    return values.map(value => ({
      name: `[${value.name}]`,
      value: value.value,
      type: value.type,
      variablesReference: 0
    }));
  }

  private async containerSyntheticVariables(reference: VariableReference, _options: FormatVariableOptions): Promise<DebugProtocol.Variable[]> {
    if (!reference.expression || !reference.metaType) {
      return [];
    }

    const valueExpression = this.metaValueExpression(reference.expression);
    switch (this.containerKind(reference.metaType)) {
      case "unorderedSet":
        return [
          this.syntheticReferenceVariable(reference, "[elements]", "expand set elements", "UnorderedSet elements", "indexedElements", {
            expression: `omc_UnorderedSet_toArray(threadData, ${valueExpression})`,
            countLabel: "elements"
          })
        ];
      case "unorderedMap":
        return [
          this.syntheticReferenceVariable(reference, "[entries]", "expand map entries", "UnorderedMap entries", "mapEntries", {
            expression: reference.expression,
            countLabel: "entries"
          }),
          this.syntheticReferenceVariable(reference, "[keys]", "expand keys", "UnorderedMap keys", "indexedElements", {
            expression: `omc_UnorderedMap_keyArray(threadData, ${valueExpression})`,
            countLabel: "keys"
          }),
          this.syntheticReferenceVariable(reference, "[values]", "expand values", "UnorderedMap values", "indexedElements", {
            expression: `omc_UnorderedMap_valueArray(threadData, ${valueExpression})`,
            countLabel: "values"
          })
        ];
      case "vector":
        return [
          this.syntheticReferenceVariable(reference, "[elements]", "expand vector elements", "Vector elements", "indexedElements", {
            expression: `omc_Vector_toArray(threadData, ${valueExpression})`,
            countLabel: "elements"
          })
        ];
      case "expandableArray":
        return [
          this.syntheticReferenceVariable(reference, "[elements]", "expand occupied elements", "ExpandableArray elements", "indexedElements", {
            expression: `omc_ExpandableArray_toList(threadData, ${valueExpression})`,
            countLabel: "elements"
          })
        ];
      case "doubleEndedList":
        return [
          this.syntheticReferenceVariable(reference, "[elements]", "expand list elements", "DoubleEnded.MutableList elements", "indexedElements", {
            expression: `omc_DoubleEnded_toListNoCopyNoClear(threadData, ${valueExpression})`,
            countLabel: "elements"
          })
        ];
      default:
        return [];
    }
  }

  private async pointerSyntheticVariables(reference: VariableReference, _options: FormatVariableOptions): Promise<DebugProtocol.Variable[]> {
    if (!reference.expression || !reference.metaType || !this.isPointerRecord(reference.metaType)) {
      return [];
    }

    return [
      await this.formatVariable(
        reference.threadId,
        reference.frame,
        this.pointerTargetExpression(reference.expression),
        "[value]",
        "modelica_metatype",
        "",
        false,
        "",
        _options
      )
    ];
  }

  private syntheticReferenceVariable(
    parent: VariableReference,
    name: string,
    value: string,
    type: string,
    syntheticKind: SyntheticKind,
    reference: Pick<VariableReference, "expression" | "metaType" | "keyExpression" | "keyMetaType" | "valueExpression" | "valueMetaType" | "countLabel">
  ): DebugProtocol.Variable {
    return {
      name,
      value,
      type,
      variablesReference: this.makeVariableReference({
        kind: "synthetic",
        syntheticKind,
        threadId: parent.threadId,
        frame: parent.frame,
        expression: reference.expression,
        metaType: reference.metaType,
        keyExpression: reference.keyExpression,
        keyMetaType: reference.keyMetaType,
        valueExpression: reference.valueExpression,
        valueMetaType: reference.valueMetaType,
        countLabel: reference.countLabel
      }),
      evaluateName: reference.expression
    };
  }

  private async getSyntheticChildren(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    switch (reference.syntheticKind) {
      case "indexedElements":
        return this.getIndexedElementChildren(reference);
      case "mapEntries":
        return this.getMapEntryChildren(reference);
      case "mapEntry":
        return this.getSingleMapEntryChildren(reference);
      case "pointerValue":
        return this.getPointerValueChildren(reference);
      default:
        return [];
    }
  }

  private async getIndexedElementChildren(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    if (!reference.expression) {
      return [];
    }

    try {
      const metaType = reference.metaType || await this.getTypeOfAny(reference.threadId, reference.frame, reference.expression, false);
      const kind = this.metaKind(metaType);
      if (kind !== "array" && kind !== "list") {
        return [this.syntheticUnavailableVariable(`Cannot expand ${metaType || "value"} as indexed elements.`)];
      }

      const count = kind === "list"
        ? await this.listLength(reference.threadId, reference.frame, reference.expression)
        : await this.arrayLength(reference.threadId, reference.frame, reference.expression);
      const indexedCount = Math.min(count, this.maxIndexedChildren);
      const variables: DebugProtocol.Variable[] = [];
      const options: FormatVariableOptions = {
        autoPrettyBudget: { remaining: this.autoPrettyMaxPerRequest }
      };

      for (let i = 1; i <= indexedCount; i++) {
        const element = await this.indexedElement(reference.threadId, reference.frame, reference.expression, i, kind);
        variables.push(await this.formatVariable(
          reference.threadId,
          reference.frame,
          element.expression,
          `[${i}]`,
          "modelica_metatype",
          "",
          false,
          element.metaType || "",
          options
        ));
      }

      if (indexedCount < count) {
        variables.push(this.truncatedChildrenVariable(count - indexedCount, reference.countLabel || "elements"));
      }
      return variables;
    } catch (error) {
      return [this.syntheticUnavailableVariable(this.shortError(error))];
    }
  }

  private async getMapEntryChildren(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    if (!reference.expression) {
      return [];
    }

    try {
      const valueExpression = this.metaValueExpression(reference.expression);
      const keysExpression = `omc_UnorderedMap_keyArray(threadData, ${valueExpression})`;
      const valuesExpression = `omc_UnorderedMap_valueArray(threadData, ${valueExpression})`;
      const keyCount = await this.safeArrayLength(reference.threadId, reference.frame, keysExpression);
      const valueCount = await this.safeArrayLength(reference.threadId, reference.frame, valuesExpression);
      if (keyCount === undefined || valueCount === undefined) {
        return [this.syntheticUnavailableVariable("Could not read UnorderedMap key/value arrays.")];
      }

      const count = Math.min(keyCount, valueCount);
      const indexedCount = Math.min(count, this.maxIndexedChildren);
      const variables: DebugProtocol.Variable[] = [];
      for (let i = 1; i <= indexedCount; i++) {
        const keyElement = await this.indexedElement(reference.threadId, reference.frame, keysExpression, i, "array");
        const valueElement = await this.indexedElement(reference.threadId, reference.frame, valuesExpression, i, "array");
        const key = await this.syntheticPreview(reference.threadId, reference.frame, keyElement.expression, keyElement.metaType);
        const value = await this.syntheticPreview(reference.threadId, reference.frame, valueElement.expression, valueElement.metaType);
        variables.push({
          name: `[${i}]`,
          value: `${key} -> ${value}`,
          type: "UnorderedMap entry",
          variablesReference: this.makeVariableReference({
            kind: "synthetic",
            syntheticKind: "mapEntry",
            threadId: reference.threadId,
            frame: reference.frame,
            expression: reference.expression,
            keyExpression: keyElement.expression,
            keyMetaType: keyElement.metaType,
            valueExpression: valueElement.expression,
            valueMetaType: valueElement.metaType
          })
        });
      }

      if (indexedCount < count) {
        variables.push(this.truncatedChildrenVariable(count - indexedCount, reference.countLabel || "entries"));
      }
      if (keyCount !== valueCount) {
        variables.push(this.syntheticUnavailableVariable(`key/value array size mismatch: keys=${keyCount}, values=${valueCount}`));
      }
      return variables;
    } catch (error) {
      return [this.syntheticUnavailableVariable(this.shortError(error))];
    }
  }

  private async getSingleMapEntryChildren(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    if (!reference.keyExpression || !reference.valueExpression) {
      return [];
    }

    const options: FormatVariableOptions = {
      autoPrettyBudget: { remaining: this.autoPrettyMaxPerRequest }
    };
    try {
      return [
        await this.formatVariable(reference.threadId, reference.frame, reference.keyExpression, "key", "modelica_metatype", "", false, reference.keyMetaType || "", options),
        await this.formatVariable(reference.threadId, reference.frame, reference.valueExpression, "value", "modelica_metatype", "", false, reference.valueMetaType || "", options)
      ];
    } catch (error) {
      return [this.syntheticUnavailableVariable(this.shortError(error))];
    }
  }

  private async getPointerValueChildren(reference: VariableReference): Promise<DebugProtocol.Variable[]> {
    if (!reference.expression) {
      return [];
    }

    const options: FormatVariableOptions = {
      autoPrettyBudget: { remaining: this.autoPrettyMaxPerRequest }
    };
    try {
      return [
        await this.formatVariable(reference.threadId, reference.frame, this.pointerTargetExpression(reference.expression), "value", "modelica_metatype", "", false, "", options)
      ];
    } catch (error) {
      return [this.syntheticUnavailableVariable(this.shortError(error))];
    }
  }

  private syntheticUnavailableVariable(message: string): DebugProtocol.Variable {
    return {
      name: "[unavailable]",
      value: message,
      type: "Error",
      variablesReference: 0
    };
  }

  private async syntheticPreview(threadId: number, frame: number, expression: string, metaType?: string): Promise<string> {
    return this.truncateSingleLine(await this.stringifyMetaValueAutomatically(threadId, frame, expression, metaType), 180);
  }

  private async indexedElement(
    threadId: number,
    frame: number,
    containerExpression: string,
    index: number,
    kind: "array" | "list"
  ): Promise<{ expression: string; metaType?: string }> {
    const fallbackExpression = kind === "list"
      ? this.listElementExpression(containerExpression, index)
      : this.arrayElementExpression(containerExpression, index);

    try {
      const child = await this.getMetaElement(threadId, frame, containerExpression, index, META_KIND_ID[kind]);
      if (child.name && child.type) {
        return { expression: child.name, metaType: child.type };
      }
    } catch {
      // Fall back to the direct indexed expression below.
    }

    return { expression: fallbackExpression };
  }

  private containerStaticLabel(metaType: string): string | undefined {
    switch (this.containerKind(metaType)) {
      case "unorderedSet":
        return "UnorderedSet";
      case "unorderedMap":
        return "UnorderedMap";
      case "vector":
        return "Vector";
      case "expandableArray":
        return "ExpandableArray";
      case "doubleEndedList":
        return "DoubleEnded.MutableList";
      default:
        return undefined;
    }
  }

  private compactPrettyValue(value: string): string {
    return value.replace(/\r?\n/g, "\\n");
  }

  private previewPrettyValue(value: string): string {
    return this.truncatePrettyValue(this.compactPrettyValue(value), this.autoPrettyMaxLength);
  }

  private truncatePrettyValue(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 15)).trimEnd()}... [truncated]`;
  }

  private listHeadExpression(expression: string): string {
    return `((void **)((char *)(${this.metaValueExpression(expression)}) - 3))[1]`;
  }

  private listTailExpression(expression: string): string {
    return `((void **)((char *)(${this.metaValueExpression(expression)}) - 3))[2]`;
  }

  private listElementExpression(listExpression: string, index: number): string {
    return `mmc_gdb_listGet(0, ${this.metaValueExpression(listExpression)}, (modelica_integer)(${index}))`;
  }

  private pointerTargetExpression(expression: string): string {
    return `((void **)((char *)(${this.metaValueExpression(expression)}) - 3))[1]`;
  }

  private referenceForMeta(threadId: number, frame: number, expression: string, metaType: string): number {
    const kind = this.metaKind(metaType);
    if (!kind) {
      return 0;
    }
    return this.makeVariableReference({ kind, threadId, frame, expression, metaType });
  }

  private metaKind(metaType: string): StructuralMetaKind | "" {
    const normalizedType = metaType.trim();
    const lowerType = normalizedType.toLowerCase();
    if (lowerType.startsWith("record<")) {
      return "record";
    }
    if (lowerType.startsWith("list<")) {
      return "list";
    }
    if (lowerType.startsWith("option<")) {
      return "option";
    }
    if (lowerType.startsWith("tuple<")) {
      return "tuple";
    }
    if (lowerType.startsWith("array<")) {
      return "array";
    }
    return "";
  }

  private isMetaType(declaredType: string): boolean {
    const normalizedType = declaredType.replace(/\s+/g, " ").trim();
    return ["modelica_metatype", "modelica_string", "metamodelica_string", "void *", "void*"].includes(normalizedType);
  }

  private displayCType(declaredType: string): string {
    const normalizedType = declaredType.replace(/\s+/g, " ").trim();
    const mapping: Record<string, string> = {
      modelica_integer: "Integer",
      modelica_boolean: "Boolean",
      modelica_real: "Real",
      modelica_string: "String",
      metamodelica_string: "String",
      modelica_metatype: "Any",
      "void *": "Any",
      "void*": "Any"
    };
    return mapping[normalizedType] || declaredType || "unknown";
  }

  private async evaluateValue(command: string): Promise<string> {
    const output = await this.gdbAdapter.sendCommand(command);
    const resultRecord = this.gdbAdapter.getGDBMIResultRecord(output);
    if (!resultRecord) {
      throw new Error(`GDB did not return a result for: ${command}`);
    }
    if (resultRecord.cls === "error") {
      throw new Error(`GDB error while evaluating ${command}: ${this.gdbResultMessage(resultRecord) || "unknown error"}`);
    }
    const valueResult = resultRecord?.miResultsList ? this.gdbAdapter.getGDBMIResult("value", resultRecord.miResultsList) : undefined;
    if (!valueResult) {
      const message = this.gdbResultMessage(resultRecord);
      const suffix = message ? `: ${message}` : ` (result class: ${resultRecord.cls || "unknown"})`;
      throw new Error(`GDB returned no value for ${command}${suffix}`);
    }
    return this.gdbAdapter.getGDBMIConstantValue(valueResult);
  }

  private gdbResultMessage(resultRecord: GDBMIResultRecord): string | undefined {
    const messageResult = this.gdbAdapter.getGDBMIResult("msg", resultRecord.miResultsList);
    const message = messageResult ? this.gdbAdapter.getGDBMIConstantValue(messageResult) : "";
    return message ? this.stripGDBCString(message) : undefined;
  }

  private async evaluateInt(command: string): Promise<number> {
    const value = await this.evaluateValue(command);
    const stripped = this.stripGDBCString(value).split(/\s+/)[0];
    return Number.parseInt(stripped, 0);
  }

  private async evaluateScalarExpression(threadId: number, frame: number, expression: string): Promise<string | undefined> {
    try {
      const value = await this.evaluateValue(CommandFactory.dataEvaluateExpression(threadId, frame, expression));
      const stripped = this.stripGDBCString(value).trim();
      return stripped ? stripped.split(/\s+/)[0] : undefined;
    } catch {
      return undefined;
    }
  }

  private metaValueExpression(expression: string): string {
    const trimmed = expression.trim();
    if (trimmed.startsWith("(modelica_metatype)")) {
      return trimmed;
    }
    return `(modelica_metatype)(mmc_uint_t)(${trimmed})`;
  }

  private forceMetaValueExpression(expression: string): string {
    const trimmed = expression.trim();
    if (/^\(modelica_metatype\)\(\(+\(mmc_uint_t\)/.test(trimmed)) {
      return trimmed;
    }

    // Explicit @ is for generated locals that hold an untagged MMC pointer
    // (commonly loop iterators inferred as integers). If the value already
    // looks tagged, keep it; otherwise add the RML pointer tag.
    return `(modelica_metatype)(((((mmc_uint_t)(${trimmed})) & 3) == 3) ? ((mmc_uint_t)(${trimmed})) : (((mmc_uint_t)(${trimmed})) + 3))`;
  }

  private async arrayLength(threadId: number, frame: number, expression: string): Promise<number> {
    return this.evaluateInt(CommandFactory.arrayLength(threadId, frame, this.metaValueExpression(expression)));
  }

  private async listLength(threadId: number, frame: number, expression: string): Promise<number> {
    return this.evaluateInt(CommandFactory.listLength(threadId, frame, this.metaValueExpression(expression)));
  }

  private async isOptionNone(threadId: number, frame: number, expression: string): Promise<number> {
    return this.evaluateInt(CommandFactory.isOptionNone(threadId, frame, this.metaValueExpression(expression)));
  }

  private async getTypeOfAny(threadId: number, frame: number, expression: string, inRecord: boolean): Promise<string> {
    const value = await this.evaluateValue(CommandFactory.getTypeOfAny(threadId, frame, this.metaValueExpression(expression), inRecord));
    return this.stripGDBCString(value);
  }

  private async anyString(threadId: number, frame: number, expression: string, printElements?: number): Promise<string> {
    const valueExpression = this.metaValueExpression(expression);
    const value = typeof printElements === "number"
      ? await this.withPrintElements(printElements, () => this.evaluateValue(CommandFactory.anyString(threadId, frame, valueExpression)))
      : await this.evaluateValue(CommandFactory.anyString(threadId, frame, valueExpression));
    return this.stripGDBCString(value);
  }

  private async modelicaString(threadId: number, frame: number, expression: string): Promise<string> {
    const value = await this.evaluateValue(CommandFactory.modelicaStringData(threadId, frame, expression));
    return this.stripGDBCString(value);
  }

  private async withPrintElements<T>(printElements: number, action: () => Promise<T>): Promise<T> {
    await this.gdbAdapter.sendCommand(CommandFactory.gdbSet(`print elements ${printElements}`), GDBCommandFlag.nonCriticalResponse);
    try {
      return await action();
    } finally {
      await this.gdbAdapter.sendCommand(CommandFactory.gdbSet(`print elements ${this.printElements}`), GDBCommandFlag.nonCriticalResponse).catch(error => logger.error(`${error}`));
    }
  }

  private async getMetaElement(threadId: number, frame: number, expression: string, index: number, metaKindId: string): Promise<{ name: string; displayName: string; type: string }> {
    const value = await this.evaluateValue(CommandFactory.getMetaTypeElement(threadId, frame, this.metaValueExpression(expression), index, metaKindId));
    const payload = this.stripGDBCString(value);
    return {
      name: this.matchPayloadField(payload, "name"),
      displayName: this.matchPayloadField(payload, "displayName"),
      type: this.matchPayloadField(payload, "type")
    };
  }

  private matchPayloadField(payload: string, field: string): string {
    const match = new RegExp(`${field}="((?:\\\\.|[^"])*)"`).exec(payload);
    return match ? this.unescapeGDBString(match[1]) : "";
  }

  private stripGDBCString(value: string): string {
    const unescaped = this.unescapeGDBString(value);
    const first = unescaped.indexOf("\"");
    const last = unescaped.lastIndexOf("\"");
    if (first >= 0 && last > first) {
      return unescaped.slice(first + 1, last);
    }
    return unescaped;
  }

  private unescapeGDBString(value: string): string {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }

  private async findLocalVariable(threadId: number, frame: number, name: string): Promise<GDBVariableInfo | undefined> {
    if (!this.isIdentifier(name)) {
      return undefined;
    }
    const variables = await this.getStackVariables(threadId, frame);
    return variables.find(variable => variable.name === name);
  }

  private async getLocalResolution(threadId: number, frame: number): Promise<LocalResolution> {
    const variables = await this.getStackVariables(threadId, frame);
    const byName = new Map<string, GDBVariableInfo>();
    const sourceToGenerated = new Map<string, string>();
    for (const variable of variables) {
      byName.set(variable.name, variable);
    }
    for (const variable of variables) {
      if (variable.name.startsWith("_") && !variable.name.startsWith("__")) {
        const sourceName = variable.name.replace(/^_/, "");
        if (this.isIdentifier(sourceName)) {
          sourceToGenerated.set(sourceName, variable.name);
        }
      }
    }
    return { byName, sourceToGenerated };
  }

  private async resolveDebugExpression(threadId: number, frame: number, expression: string): Promise<string> {
    const trimmed = expression.trim();
    if (trimmed.startsWith("@")) {
      const inner = trimmed.slice(1).trim();
      if (!inner) {
        throw new Error("Missing expression after @. Example: mm.print @cref");
      }
      return this.resolveForcedMetaExpression(threadId, frame, inner);
    }
    return this.resolvePlainDebugExpression(threadId, frame, trimmed);
  }

  private async resolvePlainDebugExpression(threadId: number, frame: number, expression: string): Promise<string> {
    const trimmed = expression.trim();
    const locals = await this.getLocalResolution(threadId, frame);
    if (this.isIdentifier(trimmed)) {
      return locals.sourceToGenerated.get(trimmed) || trimmed;
    }
    if (locals.byName.has(trimmed)) {
      return trimmed;
    }

    const withGeneratedNames = this.rewriteLocalIdentifiers(trimmed, locals);
    return this.rewriteMetaModelicaIndexing(threadId, frame, withGeneratedNames);
  }

  private isIdentifier(expression: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(expression);
  }

  private rewriteLocalIdentifiers(expression: string, locals: LocalResolution): string {
    let result = "";
    let i = 0;
    let quote = "";
    let escaped = false;

    while (i < expression.length) {
      const ch = expression[i];
      if (quote) {
        result += ch;
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = "";
        }
        i += 1;
        continue;
      }

      if (ch === "\"" || ch === "'") {
        quote = ch;
        result += ch;
        i += 1;
        continue;
      }

      if (/[A-Za-z_]/.test(ch)) {
        const start = i;
        i += 1;
        while (i < expression.length && /[A-Za-z0-9_]/.test(expression[i])) {
          i += 1;
        }

        const identifier = expression.slice(start, i);
        const previous = this.previousNonWhitespace(expression, start);
        const next = this.nextNonWhitespace(expression, i);
        if (previous === "." || next === ".") {
          result += identifier;
        } else if (locals.sourceToGenerated.has(identifier)) {
          result += locals.sourceToGenerated.get(identifier);
        } else if (locals.byName.has(identifier)) {
          result += identifier;
        } else {
          result += identifier;
        }
        continue;
      }

      result += ch;
      i += 1;
    }

    return result;
  }

  private previousNonWhitespace(expression: string, index: number): string {
    for (let i = index - 1; i >= 0; i--) {
      if (!/\s/.test(expression[i])) {
        return expression[i];
      }
    }
    return "";
  }

  private nextNonWhitespace(expression: string, index: number): string {
    for (let i = index; i < expression.length; i++) {
      if (!/\s/.test(expression[i])) {
        return expression[i];
      }
    }
    return "";
  }

  private async rewriteMetaModelicaIndexing(threadId: number, frame: number, expression: string): Promise<string> {
    let rewritten = expression;
    for (let guard = 0; guard < 32; guard++) {
      const access = this.findFirstIndexAccess(rewritten);
      if (!access) {
        break;
      }

      const base = rewritten.slice(access.baseStart, access.bracketStart).trim();
      const index = rewritten.slice(access.bracketStart + 1, access.bracketEnd).trim();
      const helper = await this.indexAccessHelper(threadId, frame, base);
      await this.validateMetaModelicaIndexAccess(threadId, frame, base, index, helper);
      const replacement = `${helper}(0, ${this.metaValueExpression(base)}, (modelica_integer)(${index}))`;
      rewritten = rewritten.slice(0, access.baseStart) + replacement + rewritten.slice(access.bracketEnd + 1);
    }
    return rewritten;
  }

  private async indexAccessHelper(threadId: number, frame: number, baseExpression: string): Promise<MetaModelicaIndexHelper> {
    try {
      const metaType = await this.getTypeOfAny(threadId, frame, baseExpression, false);
      if (/^list(?:<|$)/.test(metaType)) {
        return "mmc_gdb_listGet";
      }
    } catch {
      // Default to array access; this keeps source-level array expressions usable
      // even if the base type cannot be inspected in the selected frame.
    }
    return "mmc_gdb_arrayGet";
  }

  private async validateMetaModelicaIndexAccess(
    threadId: number,
    frame: number,
    baseExpression: string,
    indexExpression: string,
    helper: MetaModelicaIndexHelper
  ): Promise<void> {
    const indexValue = await this.evaluateScalarExpression(threadId, frame, `(modelica_integer)(${indexExpression})`);
    const index = indexValue ? Number.parseInt(indexValue, 0) : Number.NaN;
    if (!Number.isFinite(index)) {
      throw new Error(`Could not evaluate MetaModelica index "${indexExpression}" for ${baseExpression}; refusing to call the runtime getter.`);
    }

    const kind = helper === "mmc_gdb_listGet" ? "list" : "array";
    const length = helper === "mmc_gdb_listGet"
      ? await this.listLength(threadId, frame, baseExpression)
      : await this.arrayLength(threadId, frame, baseExpression);

    if (index < 1 || index > length) {
      throw new Error(`MetaModelica ${kind} index ${index} is out of bounds for ${baseExpression}; valid range is 1:${length}. MetaModelica arrays/lists are 1-based.`);
    }
  }

  private findFirstIndexAccess(expression: string): { baseStart: number; bracketStart: number; bracketEnd: number } | undefined {
    let quote = "";
    let escaped = false;
    for (let i = 0; i < expression.length; i++) {
      const ch = expression[i];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = "";
        }
        continue;
      }
      if (ch === "\"" || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch !== "[") {
        continue;
      }

      const baseStart = this.indexBaseStart(expression, i);
      if (baseStart < 0) {
        continue;
      }
      const bracketEnd = this.findMatchingClose(expression, i, "[", "]");
      if (bracketEnd < 0) {
        continue;
      }
      return { baseStart, bracketStart: i, bracketEnd };
    }
    return undefined;
  }

  private indexBaseStart(expression: string, bracketStart: number): number {
    let end = bracketStart - 1;
    while (end >= 0 && /\s/.test(expression[end])) {
      end -= 1;
    }
    if (end < 0) {
      return -1;
    }

    if (expression[end] === ")") {
      const open = this.findMatchingOpen(expression, end, "(", ")");
      if (open < 0) {
        return -1;
      }
      let start = open - 1;
      while (start >= 0 && /[A-Za-z0-9_]/.test(expression[start])) {
        start -= 1;
      }
      return start + 1;
    }

    if (!/[A-Za-z0-9_]/.test(expression[end])) {
      return -1;
    }
    let start = end;
    while (start >= 0 && /[A-Za-z0-9_]/.test(expression[start])) {
      start -= 1;
    }
    return start + 1;
  }

  private findMatchingOpen(expression: string, closeIndex: number, openChar: string, closeChar: string): number {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = closeIndex; i >= 0; i--) {
      const ch = expression[i];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = "";
        }
        continue;
      }
      if (ch === "\"" || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === closeChar) {
        depth += 1;
      } else if (ch === openChar) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  private findMatchingClose(expression: string, openIndex: number, openChar: string, closeChar: string): number {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = openIndex; i < expression.length; i++) {
      const ch = expression[i];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = "";
        }
        continue;
      }
      if (ch === "\"" || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === openChar) {
        depth += 1;
      } else if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  private async resolveForcedMetaExpression(threadId: number, frame: number, expression: string): Promise<string> {
    const trimmed = expression.trim();
    if (trimmed.startsWith("*")) {
      const inner = trimmed.slice(1).trim();
      if (!inner) {
        throw new Error("Missing expression after @*. Example: mm.print @*cref");
      }
      const resolved = await this.resolvePlainDebugExpression(threadId, frame, inner);
      return this.forceMetaValueExpression(`(*(mmc_uint_t*)(${resolved}))`);
    }
    return this.forceMetaValueExpression(await this.resolvePlainDebugExpression(threadId, frame, expression));
  }

  private async evaluateDebugConsole(threadId: number, frame: number, expression: string): Promise<DebugProtocol.EvaluateResponse["body"]> {
    const trimmed = expression.trim();
    if (this.isDiagnosticText(trimmed)) {
      return {
        result: trimmed,
        type: "Diagnostic",
        variablesReference: 0
      };
    }
    if (!trimmed || trimmed === "mm.help" || trimmed === "help mm") {
      return {
        result: this.debugConsoleHelp(),
        variablesReference: 0
      };
    }

    const [command, argument] = this.splitConsoleCommand(trimmed);
    if (["print", "p", "mm.print", "mm"].includes(command)) {
      return this.evaluateMetaPrint(threadId, frame, argument, true);
    }
    if (command === "mm.string") {
      return this.evaluateMetaString(threadId, frame, argument);
    }
    if (command === "mm.rewrite") {
      return {
        result: await this.rewriteMetaModelicaCall(threadId, frame, argument),
        variablesReference: 0
      };
    }
    if (["pp", "pretty", "mm.pretty"].includes(command)) {
      return this.evaluateMetaPretty(threadId, frame, argument);
    }
    if (command === "mm.type") {
      const resolved = await this.resolveDebugExpression(threadId, frame, argument);
      return {
        result: await this.getTypeOfAny(threadId, frame, resolved, false),
        variablesReference: 0
      };
    }
    if (command === "mm.probe") {
      return {
        result: await this.evaluateMetaProbe(threadId, frame, argument),
        variablesReference: 0
      };
    }
    if (command === "mm.raw") {
      return {
        result: await this.evaluateValue(CommandFactory.dataEvaluateExpression(threadId, frame, argument)),
        variablesReference: 0
      };
    }
    if (command === "call" || command === "mm.call") {
      const rewritten = await this.rewriteMetaModelicaCall(threadId, frame, argument);
      return {
        result: await this.runGDBConsoleCommand(threadId, frame, `call ${rewritten}`),
        variablesReference: 0
      };
    }
    if (command === "gdb" || command === "mm.gdb") {
      return {
        result: await this.runGDBConsoleCommand(threadId, frame, argument),
        variablesReference: 0
      };
    }

    const local = await this.findLocalVariable(threadId, frame, trimmed);
    if (local) {
      return this.evaluateMetaPrint(threadId, frame, local.name);
    }
    const generatedLocal = this.isIdentifier(trimmed) ? await this.findLocalVariable(threadId, frame, `_${trimmed}`) : undefined;
    if (generatedLocal) {
      return this.evaluateMetaPrint(threadId, frame, generatedLocal.name);
    }

    return {
      result: await this.evaluateValue(CommandFactory.dataEvaluateExpression(threadId, frame, trimmed)),
      variablesReference: 0
    };
  }

  private splitConsoleCommand(expression: string): [string, string] {
    if (expression === "mm") {
      return ["mm.help", ""];
    }
    if (expression.startsWith("mm ")) {
      return ["mm", expression.slice(3).trim()];
    }
    if (expression.startsWith("p ")) {
      return ["p", expression.slice(2).trim()];
    }
    const separator = expression.indexOf(" ");
    if (separator < 0) {
      return [expression, ""];
    }
    const command = expression.slice(0, separator);
    const argument = expression.slice(separator + 1).trim();
    if (["print", "call", "gdb", "pp", "pretty", "mm.print", "mm.string", "mm.pretty", "mm.rewrite", "mm.type", "mm.probe", "mm.raw", "mm.call", "mm.gdb"].includes(command)) {
      return [command, argument];
    }
    return ["", expression];
  }

  private debugConsoleHelp(): string {
    return [
      "MetaModelica debugger commands:",
      "  print EXPR       Pretty-print by convention, then fall back to expandable structural output.",
      "  p EXPR           Short alias for print.",
      "  mm.string EXPR   Explicit full anyString(EXPR) stringification; can be large.",
      "  pp EXPR using FUNCTION",
      "                   Pretty-print by calling FUNCTION(EXPR) and stringifying the result.",
      "  mm.rewrite EXPR  Show the generated C expression for a dotted MetaModelica call.",
      "  mm.type EXPR     Show getTypeOfAny(EXPR).",
      "  mm.probe EXPR    Show raw value, @ rewrite, and detected MetaModelica type.",
      "  call EXPR        Run a GDB call in the selected frame.",
      "  gdb COMMAND      Run a raw GDB console command in the selected frame.",
      "  mm.raw EXPR      Evaluate a raw GDB/C expression.",
      "",
      "Generated MetaModelica calls can be written with dots:",
      "  call BackendDump.dumpBackendDAE(dae, \"debug dae\")",
      "  mm.string NBackendDAE.toString(bdae, \"debug bdae\")",
      "  pp bdae using NBackendDAE.toString",
      "Use @arg to force a generated integer-looking local to modelica_metatype:",
      "  mm.print NFComponentRef.toString(@cref)",
      "Use @*arg only if arg is a pointer to a slot containing a MetaModelica value:",
      "  mm.type @*slot",
      "Source-level array/list indexing is normalized before GDB sees it:",
      "  mm.print comps[i]",
      "  mm.print NFComponentRef.toString(seed_vars[1])",
      "Function references in call arguments are rewritten to boxvars:",
      "  mm.print UnorderedSet.toString(seed_set, NFComponentRef.toString)",
      "UnorderedMap/UnorderedSet printing is intercepted and bounded:",
      "  mm.print map",
      "  mm.print UnorderedMap.toString(map, NFComponentRef.toString, NFComponentRef.listToString)",
      "For list<ComponentRef> locals such as seed_vars_array:",
      "  mm.print NFComponentRef.listToString(seed_vars_array)"
    ].join("\n");
  }

  private debugConsoleFailure(expression: string, error: unknown): string {
    const message = error instanceof Error ? error.message : `${error}`;
    const lines = [
      "MetaModelica debug command failed.",
      expression.trim() ? `Expression: ${expression.trim()}` : "",
      `Error: ${message}`
    ].filter(Boolean);

    if (/No symbol "mmc_mk_scon"|No symbol 'mmc_mk_scon'|mmc_mk_scon|mmc_mk_scon_len_ret_ptr/.test(message)) {
      lines.push("Hint: generated functions taking String arguments need an MMC string value. The debugger now allocates string literals directly; reload the VS Code window if you still see mmc_mk_scon_len_ret_ptr in rewritten expressions.");
    }
    if (/UnorderedSet\.toString/.test(expression) && !/,/.test(expression)) {
      lines.push("Hint: UnorderedSet.toString needs the set and an element string function, for example: mm.print UnorderedSet.toString(seed_set, NFComponentRef.toString)");
    }
    if (/UnorderedMap\.toString/.test(expression)) {
      lines.push("Hint: UnorderedMap.toString needs the map, a key string function, and a value string function.");
    }
    if (/Cannot access memory|Attempt to dereference|not a pointer|value has been optimized out/i.test(message)) {
      lines.push("Hint: if the MetaModelica value shows as an integer-looking local, force a metatype cast with @name, for example: mm.print NFComponentRef.toString(@cref)");
    }
    if (/No symbol|not in current context|No symbol table/i.test(message)) {
      lines.push("Hint: GDB could not resolve part of the expression in the selected frame. Use mm.probe EXPR to see the generated rewrite, or select the MetaModelica frame that owns the local.");
    }
    if (/timed out/i.test(message)) {
      lines.push("Hint: the called printer probably walked a large or recursive value. Try mm.rewrite first, or use a narrower toString/listToString function on a smaller field.");
    }
    if (/out of bounds|1:\d+|1-based/i.test(message)) {
      lines.push("Hint: MetaModelica arrays and lists are 1-based. Index 0 is invalid; use [1] for the first element.");
    }
    return lines.join("\n");
  }

  private async evaluateMetaProbe(threadId: number, frame: number, expression: string): Promise<string> {
    if (!expression) {
      return "usage: mm.probe EXPR";
    }

    const resolved = await this.resolvePlainDebugExpression(threadId, frame, expression);
    const local = await this.findLocalVariable(threadId, frame, resolved);
    const forced = this.forceMetaValueExpression(resolved);
    const lines = [
      `source: ${expression.trim()}`,
      `resolved: ${resolved}`
    ];
    if (local) {
      lines.push(`gdb type: ${local.type || "<unknown>"}`);
      lines.push(`gdb value: ${local.value || "<unavailable>"}`);
    } else {
      try {
        lines.push(`gdb value: ${await this.evaluateValue(CommandFactory.dataEvaluateExpression(threadId, frame, resolved))}`);
      } catch (error) {
        lines.push(`gdb error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    lines.push(`@ rewrite: ${forced}`);

    try {
      const metaType = await this.getTypeOfAny(threadId, frame, forced, false);
      lines.push(`@ type: ${metaType}`);
      if (["String", "Integer", "Boolean", "Real"].includes(metaType)) {
        lines.push(`@ value: ${await this.anyString(threadId, frame, forced)}`);
      } else if (metaType) {
        lines.push(`@ summary: ${await this.describeMetaValue(threadId, frame, forced, metaType)}`);
      }
    } catch (error) {
      lines.push(`@ error: ${error instanceof Error ? error.message : String(error)}`);
    }

    lines.push(`@* rewrite: ${this.forceMetaValueExpression(`(*(mmc_uint_t*)(${resolved}))`)}`);
    lines.push("@* is not probed automatically because dereferencing a non-slot value can disturb the inferior; use mm.type @*EXPR only for real pointer-to-slot values.");
    return lines.join("\n");
  }

  private async evaluateMetaPrint(threadId: number, frame: number, expression: string, forcePretty: boolean = false): Promise<DebugProtocol.EvaluateResponse["body"]> {
    if (!expression) {
      return { result: this.debugConsoleHelp(), variablesReference: 0 };
    }

    const containerString = await this.tryEvaluateContainerToStringCall(threadId, frame, expression);
    if (containerString) {
      return containerString;
    }

    const rewrittenCall = await this.rewriteMetaModelicaCall(threadId, frame, expression);
    if (rewrittenCall !== expression.trim()) {
      try {
        const value = await this.evaluateStringExpressionWithTimeout(threadId, frame, rewrittenCall);
        return {
          result: value === "" ? "<empty string>" : value,
          type: "String",
          variablesReference: 0
        };
      } catch (error) {
        return {
          result: `MetaModelica printer call failed.\nsource: ${expression}\nrewritten: ${rewrittenCall}\nerror: ${this.shortError(error)}`,
          type: "Error",
          variablesReference: 0
        };
      }
    }

    const resolved = await this.resolveDebugExpression(threadId, frame, expression);
    const local = await this.findLocalVariable(threadId, frame, resolved);
    if (local && !this.isMetaType(local.type)) {
      if (this.looksLikePointerValue(local.value)) {
        const metaValue = await this.tryFormatPotentialMetaValue(threadId, frame, resolved, forcePretty);
        if (metaValue) {
          return metaValue;
        }
      }
      return {
        result: local.type === "modelica_boolean"
          ? (local.value.startsWith("1") ? "true" : local.value.startsWith("0") ? "false" : local.value)
          : local.value,
        type: this.displayCType(local.type),
        variablesReference: 0
      };
    }

    const metaExpression = local && this.looksLikePointerValue(local.value)
      ? this.forceMetaValueExpression(resolved)
      : resolved;

    try {
      const metaType = await this.getTypeOfAny(threadId, frame, metaExpression, false);
      if (["String", "Integer", "Boolean", "Real"].includes(metaType)) {
        return {
          result: await this.anyString(threadId, frame, metaExpression),
          type: metaType,
          variablesReference: 0
        };
      }
      const pretty = await this.conventionalPrettyValue(threadId, frame, metaExpression, metaType, forcePretty);
      if (pretty) {
        return {
          result: pretty,
          type: metaType,
          variablesReference: 0
        };
      }
      const containerPretty = await this.tryFormatContainerValue(threadId, frame, metaExpression, metaType);
      if (containerPretty) {
        return {
          result: containerPretty,
          type: metaType,
          variablesReference: this.referenceForMeta(threadId, frame, metaExpression, metaType)
        };
      }
      return {
        result: metaType ? await this.describeMetaValue(threadId, frame, metaExpression, metaType) : "<unavailable>",
        type: metaType || "unknown",
        variablesReference: metaType ? this.referenceForMeta(threadId, frame, metaExpression, metaType) : 0
      };
    } catch (error) {
      if (expression.trim().startsWith("@")) {
        throw error;
      }
      return {
        result: this.stripGDBCString(await this.evaluateValue(CommandFactory.dataEvaluateExpression(threadId, frame, resolved))),
        variablesReference: 0
      };
    }
  }

  private async evaluateMetaString(threadId: number, frame: number, expression: string): Promise<DebugProtocol.EvaluateResponse["body"]> {
    if (!expression) {
      return { result: "usage: mm.string EXPR", variablesReference: 0 };
    }
    const containerString = await this.tryEvaluateContainerToStringCall(threadId, frame, expression);
    if (containerString) {
      return containerString;
    }
    const rewrittenCall = await this.rewriteMetaModelicaCall(threadId, frame, expression);
    if (rewrittenCall !== expression.trim()) {
      try {
        const value = await this.evaluateStringExpressionWithTimeout(threadId, frame, rewrittenCall);
        return {
          result: value === "" ? "<empty string>" : value,
          type: "String",
          variablesReference: 0
        };
      } catch (error) {
        return {
          result: `MetaModelica string call failed.\nsource: ${expression}\nrewritten: ${rewrittenCall}\nerror: ${this.shortError(error)}`,
          type: "Error",
          variablesReference: 0
        };
      }
    }
    const resolved = await this.resolveDebugExpression(threadId, frame, expression);
    return {
      result: await this.anyString(threadId, frame, resolved),
      variablesReference: 0
    };
  }

  private async evaluateMetaPretty(threadId: number, frame: number, expression: string): Promise<DebugProtocol.EvaluateResponse["body"]> {
    if (!expression) {
      return { result: "usage: pp EXPR using FUNCTION", variablesReference: 0 };
    }

    const usingMatch = /^([\s\S]+?)\s+using\s+([A-Za-z_][A-Za-z0-9_.]*)$/.exec(expression.trim());
    if (!usingMatch) {
      return this.evaluateMetaPrint(threadId, frame, expression);
    }

    const resolvedExpression = await this.resolveDebugExpression(threadId, frame, usingMatch[1]);
    const rewrittenCall = await this.rewriteMetaModelicaCall(threadId, frame, `${usingMatch[2]}(${resolvedExpression})`);
    try {
      const value = await this.evaluateStringExpressionWithTimeout(threadId, frame, rewrittenCall);
      return {
        result: value === "" ? "<empty string>" : value,
        type: "String",
        variablesReference: 0
      };
    } catch (error) {
      return {
        result: `MetaModelica pretty call failed.\nsource: ${expression}\nrewritten: ${rewrittenCall}\nerror: ${this.shortError(error)}`,
        type: "Error",
        variablesReference: 0
      };
    }
  }

  private async evaluateStringExpression(threadId: number, frame: number, expression: string): Promise<string> {
    try {
      return await this.modelicaString(threadId, frame, expression);
    } catch {
      try {
        return this.stripGDBCString(await this.evaluateValue(CommandFactory.dataEvaluateExpression(threadId, frame, expression)));
      } catch {
        return await this.anyString(threadId, frame, expression);
      }
    }
  }

  private async evaluateStringExpressionWithTimeout(threadId: number, frame: number, expression: string): Promise<string> {
    let timeout: NodeJS.Timeout | undefined;
    const timed = new Promise<string>((_, reject) => {
      timeout = setTimeout(() => {
        this.gdbAdapter.interrupt();
        reject(new Error(`Pretty-printer timed out after ${this.debugConsoleTimeoutMs} ms. The GDB target was interrupted.`));
      }, this.debugConsoleTimeoutMs);
    });
    try {
      return await Promise.race([this.evaluateStringExpression(threadId, frame, expression), timed]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async tryEvaluateContainerToStringCall(threadId: number, frame: number, expression: string): Promise<DebugProtocol.EvaluateResponse["body"] | undefined> {
    const trimmed = expression.trim();
    const match = /^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/.exec(trimmed);
    if (!match) {
      return undefined;
    }

    const sourceName = match[1];
    if (sourceName !== "UnorderedMap.toString" && sourceName !== "UnorderedSet.toString") {
      return undefined;
    }

    const args = this.splitTopLevelArgs(match[2]);
    if (sourceName === "UnorderedSet.toString") {
      if (args.length < 1) {
        throw new Error("UnorderedSet.toString needs a set expression.");
      }
      const setExpression = await this.resolveMetaValueForEvaluation(threadId, frame, args[0]);
      return {
        result: await this.unorderedSetToDebugString(threadId, frame, setExpression, this.normalizePrinterName(args[1])),
        type: "String",
        variablesReference: 0
      };
    }

    if (args.length < 1) {
      throw new Error("UnorderedMap.toString needs a map expression.");
    }
    const mapExpression = await this.resolveMetaValueForEvaluation(threadId, frame, args[0]);
    return {
      result: await this.unorderedMapToDebugString(
        threadId,
        frame,
        mapExpression,
        this.normalizePrinterName(args[1]),
        this.normalizePrinterName(args[2])
      ),
      type: "String",
      variablesReference: 0
    };
  }

  private async tryFormatContainerValue(threadId: number, frame: number, expression: string, metaType: string): Promise<string | undefined> {
    switch (this.containerKind(metaType)) {
      case "unorderedSet":
        return this.unorderedSetToDebugString(threadId, frame, expression);
      case "unorderedMap":
        return this.unorderedMapToDebugString(threadId, frame, expression);
      default:
        return undefined;
    }
  }

  private async resolveMetaValueForEvaluation(threadId: number, frame: number, expression: string): Promise<string> {
    const resolved = await this.resolveDebugExpression(threadId, frame, expression);
    const local = await this.findLocalVariable(threadId, frame, resolved);
    return local && this.looksLikePointerValue(local.value)
      ? this.forceMetaValueExpression(resolved)
      : resolved;
  }

  private normalizePrinterName(printer: string | undefined): string | undefined {
    const trimmed = printer?.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.replace(/^function\s+/, "").trim();
  }

  private async unorderedSetToDebugString(threadId: number, frame: number, setExpression: string, elementPrinter?: string): Promise<string> {
    const valueExpression = this.metaValueExpression(setExpression);
    const elementsExpression = `omc_UnorderedSet_toArray(threadData, ${valueExpression})`;
    let count: number;
    try {
      count = await this.arrayLength(threadId, frame, elementsExpression);
    } catch (error) {
      return `UnorderedSet (elements unavailable: ${this.shortError(error)})`;
    }
    const limit = Math.min(count, this.maxIndexedChildren);
    const lines = [`UnorderedSet (${count} ${count === 1 ? "element" : "elements"})`];

    for (let i = 1; i <= limit; i++) {
      const element = await this.indexedElement(threadId, frame, elementsExpression, i, "array");
      lines.push(`[${i}] ${await this.stringifyMetaValueForContainer(threadId, frame, element.expression, elementPrinter, element.metaType)}`);
    }
    if (limit < count) {
      lines.push(`... ${count - limit} more elements not shown`);
    }

    return lines.join("\n");
  }

  private async unorderedMapToDebugString(
    threadId: number,
    frame: number,
    mapExpression: string,
    keyPrinter?: string,
    valuePrinter?: string
  ): Promise<string> {
    const valueExpression = this.metaValueExpression(mapExpression);
    const keysExpression = `omc_UnorderedMap_keyArray(threadData, ${valueExpression})`;
    const valuesExpression = `omc_UnorderedMap_valueArray(threadData, ${valueExpression})`;
    let keyCount: number;
    let valueCount: number;
    try {
      keyCount = await this.arrayLength(threadId, frame, keysExpression);
      valueCount = await this.arrayLength(threadId, frame, valuesExpression);
    } catch (error) {
      return `UnorderedMap (entries unavailable: ${this.shortError(error)})`;
    }
    const count = Math.min(keyCount, valueCount);
    const limit = Math.min(count, this.maxIndexedChildren);
    const lines = [`UnorderedMap (${count} ${count === 1 ? "entry" : "entries"})`];

    for (let i = 1; i <= limit; i++) {
      const keyElement = await this.indexedElement(threadId, frame, keysExpression, i, "array");
      const valueElement = await this.indexedElement(threadId, frame, valuesExpression, i, "array");
      const key = await this.stringifyMetaValueForContainer(threadId, frame, keyElement.expression, keyPrinter, keyElement.metaType);
      const value = await this.stringifyMetaValueForContainer(threadId, frame, valueElement.expression, valuePrinter, valueElement.metaType);
      lines.push(`[${i}] ${key} -> ${value}`);
    }
    if (limit < count) {
      lines.push(`... ${count - limit} more entries not shown`);
    }
    if (keyCount !== valueCount) {
      lines.push(`<warning: key/value array size mismatch: keys=${keyCount}, values=${valueCount}>`);
    }

    return lines.join("\n");
  }

  private arrayElementExpression(arrayExpression: string, index: number): string {
    return `mmc_gdb_arrayGet(0, ${this.metaValueExpression(arrayExpression)}, (modelica_integer)(${index}))`;
  }

  private async stringifyMetaValueForContainer(threadId: number, frame: number, expression: string, printer?: string, metaType?: string): Promise<string> {
    if (printer) {
      try {
        return await this.evaluateStringExpression(threadId, frame, await this.directPrinterCall(threadId, frame, printer, expression));
      } catch (error) {
        const fallback = await this.stringifyMetaValueAutomatically(threadId, frame, expression, metaType);
        return `${fallback} <${printer} failed: ${this.shortError(error)}>`;
      }
    }

    return this.stringifyMetaValueAutomatically(threadId, frame, expression, metaType);
  }

  private async stringifyMetaValueAutomatically(threadId: number, frame: number, expression: string, knownMetaType?: string): Promise<string> {
    try {
      const metaType = knownMetaType || await this.getTypeOfAny(threadId, frame, expression, false);
      if (["String", "Integer", "Boolean", "Real"].includes(metaType)) {
        return await this.anyString(threadId, frame, expression);
      }

      const pretty = await this.conventionalPrettyValue(threadId, frame, expression, metaType, true);
      if (pretty !== undefined) {
        return pretty;
      }

      const containerPretty = await this.tryFormatContainerValue(threadId, frame, expression, metaType);
      if (containerPretty !== undefined) {
        return containerPretty;
      }

      return metaType ? await this.describeMetaValue(threadId, frame, expression, metaType) : "<unavailable>";
    } catch (error) {
      return `<unavailable: ${this.shortError(error)}>`;
    }
  }

  private async directPrinterCall(threadId: number, frame: number, printer: string, expression: string): Promise<string> {
    const valueExpression = this.metaValueExpression(expression);
    if (this.isDottedIdentifier(printer)) {
      const generatedName = `omc_${printer.replace(/\./g, "_")}`;
      const args = await this.addDefaultMetaModelicaCallArguments(threadId, frame, generatedName, [valueExpression]);
      return `${generatedName}(threadData, ${args.join(", ")})`;
    }

    switch (printer) {
      case "intString":
      case "intStringChar":
        return `${printer}(mmc_unbox_integer(${valueExpression}))`;
      case "boolString":
        return `boolString(mmc_unbox_integer(${valueExpression}))`;
      case "realString":
        return `realString(mmc_unbox_real(${valueExpression}))`;
      default:
        return `${printer}(${valueExpression})`;
    }
  }

  private shortError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, " ").slice(0, 180);
  }

  private async evaluateDebugConsoleWithTimeout(threadId: number, frame: number, expression: string): Promise<DebugProtocol.EvaluateResponse["body"]> {
    let timeout: NodeJS.Timeout | undefined;
    const timed = new Promise<DebugProtocol.EvaluateResponse["body"]>((_, reject) => {
      timeout = setTimeout(() => {
        this.gdbAdapter.interrupt();
        reject(new Error(`Debug Console evaluation timed out after ${this.debugConsoleTimeoutMs} ms. The GDB target was interrupted.`));
      }, this.debugConsoleTimeoutMs);
    });
    try {
      return await Promise.race([this.evaluateDebugConsole(threadId, frame, expression), timed]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async rewriteMetaModelicaCall(threadId: number, frame: number, expression: string): Promise<string> {
    const trimmed = expression.trim();
    const match = /^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/.exec(trimmed);
    if (!match || !match[1].includes(".")) {
      return trimmed;
    }

    let args: string[] = [];
    for (const arg of this.splitTopLevelArgs(match[2])) {
      args.push(await this.resolveMetaModelicaCallArgument(threadId, frame, arg));
    }
    const generatedName = `omc_${match[1].replace(/\./g, "_")}`;
    this.validateMetaModelicaCall(match[1], generatedName, args.length);
    args = await this.addDefaultMetaModelicaCallArguments(threadId, frame, generatedName, args);
    return args.length > 0
      ? `${generatedName}(threadData, ${args.join(", ")})`
      : `${generatedName}(threadData)`;
  }

  private async addDefaultMetaModelicaCallArguments(threadId: number, frame: number, generatedName: string, args: string[]): Promise<string[]> {
    const params = await this.generatedFunctionSignature(threadId, frame, generatedName);
    if (!params || params.length <= args.length + 1) {
      return args;
    }

    const padded = [...args];
    for (const param of params.slice(args.length + 1)) {
      const defaultArgument = this.defaultMetaModelicaArgumentForParameter(generatedName, param);
      if (defaultArgument === undefined) {
        return args;
      }
      padded.push(defaultArgument);
    }
    return padded;
  }

  private defaultMetaModelicaArgumentForParameter(generatedName: string, param: string): string | undefined {
    const sourceDefault = this.sourceDefaultArgumentForParameter(generatedName, this.generatedParameterSourceName(param));
    if (sourceDefault !== undefined) {
      return sourceDefault;
    }
    if (this.isModelicaStringParameter(param)) {
      return this.modelicaStringLiteralExpression('""');
    }
    if (this.isModelicaMetatypeParameter(param)) {
      return this.modelicaNoneExpression();
    }
    if (this.isModelicaBooleanParameter(param)) {
      return "1";
    }
    return undefined;
  }

  private sourceDefaultArgumentForParameter(generatedName: string, sourceName: string | undefined): string | undefined {
    if (!sourceName) {
      return undefined;
    }
    const defaults = this.sourceDefaultsForGeneratedFunction(generatedName);
    return defaults.get(sourceName);
  }

  private sourceDefaultsForGeneratedFunction(generatedName: string): Map<string, string> {
    const cached = this.generatedFunctionSourceDefaultsCache.get(generatedName);
    if (cached) {
      return cached;
    }

    const defaults = new Map<string, string>();
    const source = this.generatedFunctionSourceInfo(generatedName);
    if (!source) {
      this.generatedFunctionSourceDefaultsCache.set(generatedName, defaults);
      return defaults;
    }

    const filePath = this.findModelicaSourceFile(source.moduleName);
    if (!filePath) {
      this.generatedFunctionSourceDefaultsCache.set(generatedName, defaults);
      return defaults;
    }

    try {
      const text = fs.readFileSync(filePath, "utf8");
      for (const body of this.findModelicaFunctionBodies(text, source.functionName)) {
        for (const input of this.modelicaInputDeclarations(body)) {
          const parsed = this.parseModelicaInputDefault(input);
          if (parsed) {
            defaults.set(parsed.name, parsed.defaultExpression);
          }
        }
      }
    } catch {
      // Keep the empty defaults map cached.
    }

    this.generatedFunctionSourceDefaultsCache.set(generatedName, defaults);
    return defaults;
  }

  private generatedParameterSourceName(param: string): string | undefined {
    const match = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/.exec(param.trim());
    if (!match) {
      return undefined;
    }

    const cName = match[1].replace(/^_+/, "");
    const decoded = cName
      .replace(/omcQ_24/g, "")
      .replace(/Q_24/g, "")
      .replace(/_5F/g, "_");
    return decoded.replace(/^in_/, "");
  }

  private generatedFunctionSourceInfo(generatedName: string): { moduleName: string; functionName: string } | undefined {
    if (!generatedName.startsWith("omc_")) {
      return undefined;
    }
    const parts = generatedName.slice(4).split("_");
    if (parts.length < 2) {
      return undefined;
    }
    return {
      moduleName: parts[0],
      functionName: parts[parts.length - 1]
    };
  }

  private findModelicaSourceFile(moduleName: string): string | undefined {
    for (const root of this.openModelicaRootCandidates()) {
      const compilerRoot = path.join(root, "OMCompiler", "Compiler");
      const found = this.findFileByName(compilerRoot, `${moduleName}.mo`, 7);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private findFileByName(directory: string, fileName: string, maxDepth: number): string | undefined {
    if (maxDepth < 0) {
      return undefined;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "build") {
        continue;
      }
      const found = this.findFileByName(path.join(directory, entry.name), fileName, maxDepth - 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private findModelicaFunctionBodies(text: string, functionName: string): string[] {
    const bodies: string[] = [];
    const startRegex = new RegExp(`\\bfunction\\s+${this.escapeRegExp(functionName)}\\b`, "g");
    let start: RegExpExecArray | null;
    while ((start = startRegex.exec(text)) !== null) {
      const end = new RegExp(`\\bend\\s+${this.escapeRegExp(functionName)}\\s*;`, "g");
      end.lastIndex = start.index;
      const endMatch = end.exec(text);
      if (endMatch) {
        bodies.push(text.slice(start.index, endMatch.index));
        startRegex.lastIndex = endMatch.index + endMatch[0].length;
      }
    }
    return bodies;
  }

  private modelicaInputDeclarations(functionBody: string): string[] {
    const declarations: string[] = [];
    const inputRegex = /\binput(?:\s+output)?\s+([^;]+);/g;
    let match: RegExpExecArray | null;
    while ((match = inputRegex.exec(functionBody)) !== null) {
      declarations.push(match[1].trim());
    }
    return declarations;
  }

  private parseModelicaInputDefault(declaration: string): { name: string; defaultExpression: string } | undefined {
    const withoutComment = declaration.replace(/"[^"]*"\s*$/g, "").trim();
    const match = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^=]+?)\s*$/.exec(withoutComment);
    if (!match) {
      return undefined;
    }

    const defaultExpression = this.modelicaDefaultToGDBExpression(match[2].trim());
    return defaultExpression === undefined ? undefined : { name: match[1], defaultExpression };
  }

  private modelicaDefaultToGDBExpression(defaultExpression: string): string | undefined {
    if (/^-?\d+$/.test(defaultExpression)) {
      return defaultExpression;
    }
    if (/^true$/i.test(defaultExpression)) {
      return "1";
    }
    if (/^false$/i.test(defaultExpression)) {
      return "0";
    }
    if (this.isStringLiteral(defaultExpression)) {
      return this.modelicaStringLiteralExpression(defaultExpression);
    }
    if (/^NONE\s*\(\s*\)$/i.test(defaultExpression)) {
      return this.modelicaNoneExpression();
    }
    return undefined;
  }

  private async resolveMetaModelicaCallArgument(threadId: number, frame: number, argument: string): Promise<string> {
    const trimmed = argument.trim();
    if (/^(NONE|mmc_mk_none)\s*\(\s*\)$/i.test(trimmed)) {
      return this.modelicaNoneExpression();
    }
    if (/^SOME\s*\(/i.test(trimmed)) {
      const inner = this.singleCallArgument(trimmed, "SOME");
      return this.modelicaSomeExpression(await this.resolveMetaModelicaCallArgument(threadId, frame, inner));
    }
    if (this.isDottedIdentifier(trimmed)) {
      return `boxvar_${trimmed.replace(/\./g, "_")}`;
    }
    if (this.isKnownBoxvarIdentifier(trimmed)) {
      return `boxvar_${trimmed}`;
    }
    if (this.isStringLiteral(trimmed)) {
      return this.modelicaStringLiteralExpression(trimmed);
    }
    if (/^(true|false)$/i.test(trimmed)) {
      return /^true$/i.test(trimmed) ? "1" : "0";
    }

    const forceMetaType = trimmed.startsWith("@");
    if (forceMetaType) {
      return this.resolveForcedMetaExpression(threadId, frame, trimmed.slice(1).trim());
    }

    const resolved = await this.resolvePlainDebugExpression(threadId, frame, trimmed);
    const local = await this.findLocalVariable(threadId, frame, resolved);
    if (local && this.looksLikePointerValue(local.value)) {
      return this.forceMetaValueExpression(resolved);
    }
    return resolved;
  }

  private modelicaStringLiteralExpression(literal: string): string {
    let byteLength = Math.max(0, literal.length - 2);
    let value = "";
    try {
      value = JSON.parse(literal);
      byteLength = Buffer.byteLength(value, "utf8");
    } catch {
      // Keep the raw quoted literal; GDB/C will report syntax errors if invalid.
    }
    if (byteLength === 0) {
      return "(modelica_string)mmc_emptystring";
    }
    const escaped = JSON.stringify(value);
    const log2SizeInt = "((sizeof(void*) == 8) ? 3 : 2)";
    const header = `((((mmc_uint_t)${byteLength}) << 3) + ((1 << (3 + ${log2SizeInt})) + 5))`;
    const slots = `((${header}) >> (3 + ${log2SizeInt}))`;
    const nwords = `((${slots}) + 1)`;
    return `({ mmc_uint_t *mm_dbg_s = (mmc_uint_t*)omc_alloc_interface.malloc_atomic(${nwords} * sizeof(void*)); mm_dbg_s[0] = ${header}; memcpy((char*)(mm_dbg_s + 1), ${escaped}, ${byteLength}); ((char*)(mm_dbg_s + 1))[${byteLength}] = 0; (modelica_string)((char*)mm_dbg_s + 3); })`;
  }

  private modelicaNoneExpression(): string {
    return "({ mmc_uint_t *mm_dbg_none = (mmc_uint_t*)omc_alloc_interface.malloc_atomic(sizeof(void*)); mm_dbg_none[0] = ((0 << 10) + (1 << 2)); (modelica_metatype)((char*)mm_dbg_none + 3); })";
  }

  private modelicaSomeExpression(valueExpression: string): string {
    return `({ mmc_uint_t *mm_dbg_some = (mmc_uint_t*)omc_alloc_interface.malloc_atomic(2 * sizeof(void*)); mm_dbg_some[0] = ((1 << 10) + (1 << 2)); ((void**)mm_dbg_some)[1] = (void*)(${valueExpression}); (modelica_metatype)((char*)mm_dbg_some + 3); })`;
  }

  private singleCallArgument(expression: string, functionName: string): string {
    const open = expression.indexOf("(");
    const close = this.findMatchingClose(expression, open, "(", ")");
    if (open < 0 || close !== expression.length - 1) {
      throw new Error(`${functionName} expects exactly one argument.`);
    }
    const args = this.splitTopLevelArgs(expression.slice(open + 1, close));
    if (args.length !== 1) {
      throw new Error(`${functionName} expects exactly one argument.`);
    }
    return args[0];
  }

  private validateMetaModelicaCall(sourceName: string, generatedName: string, argumentCount: number): void {
    if (generatedName === "omc_UnorderedSet_toString" && argumentCount < 2) {
      throw new Error(`${sourceName} needs an element string function. Example: mm.print UnorderedSet.toString(seed_set, NFComponentRef.toString)`);
    }
    if (generatedName === "omc_UnorderedMap_toString" && argumentCount < 3) {
      throw new Error(`${sourceName} needs key and value string functions. Example: mm.print UnorderedMap.toString(map, AbsynUtil.pathString, NFFunction.Function.toString)`);
    }
  }

  private isDottedIdentifier(expression: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(expression);
  }

  private isKnownBoxvarIdentifier(expression: string): boolean {
    return ["intString", "intStringChar", "realString", "boolString"].includes(expression);
  }

  private isStringLiteral(expression: string): boolean {
    return /^"(?:\\.|[^"\\])*"$/.test(expression);
  }

  private looksLikePointerValue(value: string): boolean {
    const token = value.trim().split(/\s+/)[0];
    let numericValue: bigint;
    if (/^0x[0-9a-f]+$/i.test(token)) {
      numericValue = BigInt(token);
    } else if (/^[0-9]+$/.test(token)) {
      numericValue = BigInt(token);
    } else {
      return false;
    }

    return numericValue > 0x100000n;
  }

  private splitTopLevelArgs(args: string): string[] {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote) {
        if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = "";
        }
        continue;
      }
      if (ch === "\"" || ch === "'") {
        quote = ch;
        continue;
      }
      if ("([{".includes(ch)) {
        depth += 1;
        continue;
      }
      if (")]}".includes(ch)) {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (ch === "," && depth === 0) {
        result.push(args.slice(start, i).trim());
        start = i + 1;
      }
    }
    const tail = args.slice(start).trim();
    if (tail) {
      result.push(tail);
    }
    return result;
  }

  private async runGDBConsoleCommand(threadId: number, frame: number, command: string): Promise<string> {
    await this.gdbAdapter.sendCommand(CommandFactory.threadSelect(threadId), GDBCommandFlag.nonCriticalResponse);
    await this.gdbAdapter.sendCommand(CommandFactory.stackSelectFrame(frame), GDBCommandFlag.nonCriticalResponse);
    await this.gdbAdapter.sendCommand(command, GDBCommandFlag.consoleCommand);
    return "done";
  }

  // protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
  //   const container = this._variableHandles.get(args.variablesReference);
  //   const rv = container === 'locals'
  //     ? this._runtime.getLocalVariable(args.name)
  //     : container instanceof RuntimeVariable && container.value instanceof Array
  //     ? container.value.find(v => v.name === args.name)
  //     : undefined;

  //   if (rv) {
  //     rv.value = this.convertToRuntime(args.value);
  //     response.body = this.convertFromRuntime(rv);

  //     if (rv.memory && rv.reference) {
  //       this.sendEvent(new MemoryEvent(String(rv.reference), 0, rv.memory.length));
  //     }
  //   }

  //   this.sendResponse(response);
  // }

  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    this.gdbAdapter.sendCommand(CommandFactory.execContinue()).catch(error => logger.error(`${error}`));
    this.sendResponse(response);
  }

  protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
    // this._runtime.continue(true);
    this.sendResponse(response);
   }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    this.gdbAdapter.sendCommand(CommandFactory.execNext()).catch(error => logger.error(`${error}`));
    this.sendResponse(response);
  }

  protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
    // this._runtime.step(args.granularity === 'instruction', true);
    this.sendResponse(response);
  }

  protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
    // const targets = this._runtime.getStepInTargets(args.frameId);
    // response.body = {
    //   targets: targets.map(t => {
    //     return { id: t.id, label: t.label };
    //   })
    // };
    this.sendResponse(response);
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    this.gdbAdapter.sendCommand(CommandFactory.execStep()).catch(error => logger.error(`${error}`));
    this.sendResponse(response);
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
    this.gdbAdapter.sendCommand(CommandFactory.execFinish()).catch(error => logger.error(`${error}`));
    this.sendResponse(response);
  }

  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
    try {
      const frame = typeof args.frameId === "number" ? args.frameId : this.selectedFrame;
      response.body = await this.evaluateDebugConsoleWithTimeout(this.selectedThread, frame, args.expression || "");
      this.sendResponse(response);
    } catch (error) {
      response.body = {
        result: this.debugConsoleFailure(args.expression || "", error),
        type: "Error",
        variablesReference: 0
      };
      this.sendResponse(response);
    }
  }

  protected async customRequest(command: string, response: DebugProtocol.Response, args: any): Promise<void> {
    if (command === "metamodelica.prettyPrintVariable") {
      try {
        const expression = String(args?.expression || args?.evaluateName || args?.name || "").trim();
        if (!expression) {
          this.sendErrorResponse(response, 1, "No variable expression available for pretty printing.");
          return;
        }
        if (this.isDiagnosticText(expression)) {
          this.sendErrorResponse(response, 1, "The selected row is a diagnostic message, not a printable MetaModelica expression.");
          return;
        }

        (response as DebugProtocol.Response & { body?: any }).body = await this.evaluateMetaPrint(this.selectedThread, this.selectedFrame, expression, true);
        this.sendResponse(response);
      } catch (error) {
        this.sendErrorResponse(response, 1, `${error}`);
      }
      return;
    }

    super.customRequest(command, response, args);
  }

  private isDiagnosticText(expression: string): boolean {
    return /^(Error:|MetaModelica debug command failed\.|No conventional MetaModelica pretty-printer|\[unavailable\]|<unavailable)/.test(expression);
  }

  // protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {

  //   if (args.expression.startsWith('$')) {
  //     const rv = this._runtime.getLocalVariable(args.expression.substr(1));
  //     if (rv) {
  //       rv.value = this.convertToRuntime(args.value);
  //       response.body = this.convertFromRuntime(rv);
  //       this.sendResponse(response);
  //     } else {
  //       this.sendErrorResponse(response, {
  //         id: 1002,
  //         format: `variable '{lexpr}' not found`,
  //         variables: { lexpr: args.expression },
  //         showUser: true
  //       });
  //     }
  //   } else {
  //     this.sendErrorResponse(response, {
  //       id: 1003,
  //       format: `'{lexpr}' not an assignable expression`,
  //       variables: { lexpr: args.expression },
  //       showUser: true
  //     });
  //   }
  // }

  // private async progressSequence() {

  //   const ID = '' + this._progressId++;

  //   await timeout(100);

  //   const title = this._isProgressCancellable ? 'Cancellable operation' : 'Long running operation';
  //   const startEvent: DebugProtocol.ProgressStartEvent = new ProgressStartEvent(ID, title);
  //   startEvent.body.cancellable = this._isProgressCancellable;
  //   this._isProgressCancellable = !this._isProgressCancellable;
  //   this.sendEvent(startEvent);
  //   this.sendEvent(new OutputEvent(`start progress: ${ID}\n`));

  //   let endMessage = 'progress ended';

  //   for (let i = 0; i < 100; i++) {
  //     await timeout(500);
  //     this.sendEvent(new ProgressUpdateEvent(ID, `progress: ${i}`));
  //     if (this._cancelledProgressId === ID) {
  //       endMessage = 'progress cancelled';
  //       this._cancelledProgressId = undefined;
  //       this.sendEvent(new OutputEvent(`cancel progress: ${ID}\n`));
  //       break;
  //     }
  //   }
  //   this.sendEvent(new ProgressEndEvent(ID, endMessage));
  //   this.sendEvent(new OutputEvent(`end progress: ${ID}\n`));

  //   this._cancelledProgressId = undefined;
  // }

  // protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

  //   response.body = {
  //           dataId: null,
  //           description: "cannot break on data access",
  //           accessTypes: undefined,
  //           canPersist: false
  //       };

  //   if (args.variablesReference && args.name) {
  //     const v = this._variableHandles.get(args.variablesReference);
  //     if (v === 'globals') {
  //       response.body.dataId = args.name;
  //       response.body.description = args.name;
  //       response.body.accessTypes = [ "write" ];
  //       response.body.canPersist = true;
  //     } else {
  //       response.body.dataId = args.name;
  //       response.body.description = args.name;
  //       response.body.accessTypes = ["read", "write", "readWrite"];
  //       response.body.canPersist = true;
  //     }
  //   }

  //   this.sendResponse(response);
  // }

  // protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

  //   // clear all data breakpoints
  //   this._runtime.clearAllDataBreakpoints();

  //   response.body = {
  //     breakpoints: []
  //   };

  //   for (const dbp of args.breakpoints) {
  //     const ok = this._runtime.setDataBreakpoint(dbp.dataId, dbp.accessType || 'write');
  //     response.body.breakpoints.push({
  //       verified: ok
  //     });
  //   }

  //   this.sendResponse(response);
  // }

  // protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

  //   response.body = {
  //     targets: [
  //       {
  //         label: "item 10",
  //         sortText: "10"
  //       },
  //       {
  //         label: "item 1",
  //         sortText: "01",
  //         detail: "detail 1"
  //       },
  //       {
  //         label: "item 2",
  //         sortText: "02",
  //         detail: "detail 2"
  //       },
  //       {
  //         label: "array[]",
  //         selectionStart: 6,
  //         sortText: "03"
  //       },
  //       {
  //         label: "func(arg)",
  //         selectionStart: 5,
  //         selectionLength: 3,
  //         sortText: "04"
  //       }
  //     ]
  //   };
  //   this.sendResponse(response);
  // }

  // protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
  //   if (args.requestId) {
  //     this._cancellationTokens.set(args.requestId, true);
  //   }
  //   if (args.progressId) {
  //     this._cancelledProgressId= args.progressId;
  //   }
  // }

  // protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments) {
  //   const memoryInt = args.memoryReference.slice(3);
  //   const baseAddress = parseInt(memoryInt);
  //   const offset = args.instructionOffset || 0;
  //   const count = args.instructionCount;

  //   const isHex = memoryInt.startsWith('0x');
  //   const pad = isHex ? memoryInt.length-2 : memoryInt.length;

  //   const loc = this.createSource(this._runtime.sourceFile);

  //   let lastLine = -1;

  //   const instructions = this._runtime.disassemble(baseAddress+offset, count).map(instruction => {
  //     const address = Math.abs(instruction.address).toString(isHex ? 16 : 10).padStart(pad, '0');
  //     const sign = instruction.address < 0 ? '-' : '';
  //     const instr : DebugProtocol.DisassembledInstruction = {
  //       address: sign + (isHex ? `0x${address}` : `${address}`),
  //       instruction: instruction.instruction
  //     };
  //     // if instruction's source starts on a new line add the source to instruction
  //     if (instruction.line !== undefined && lastLine !== instruction.line) {
  //       lastLine = instruction.line;
  //       instr.location = loc;
  //       instr.line = this.convertDebuggerLineToClient(instruction.line);
  //     }
  //     return instr;
  //   });

  //   response.body = {
  //     instructions: instructions
  //   };
  //   this.sendResponse(response);
  // }

  // protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments) {

  //   // clear all instruction breakpoints
  //   this._runtime.clearInstructionBreakpoints();

  //   // set instruction breakpoints
  //   const breakpoints = args.breakpoints.map(ibp => {
  //     const address = parseInt(ibp.instructionReference.slice(3));
  //     const offset = ibp.offset || 0;
  //     return <DebugProtocol.Breakpoint>{
  //       verified: this._runtime.setInstructionBreakpoint(address + offset)
  //     };
  //   });

  //   response.body = {
  //     breakpoints: breakpoints
  //   };
  //   this.sendResponse(response);
  // }

  // //---- helpers

  // private convertToRuntime(value: string): IRuntimeVariableType {

  //   value= value.trim();

  //   if (value === 'true') {
  //     return true;
  //   }
  //   if (value === 'false') {
  //     return false;
  //   }
  //   if (value[0] === '\'' || value[0] === '"') {
  //     return value.substr(1, value.length-2);
  //   }
  //   const n = parseFloat(value);
  //   if (!isNaN(n)) {
  //     return n;
  //   }
  //   return value;
  // }

  // private convertFromRuntime(v: RuntimeVariable): DebugProtocol.Variable {

  //   const dapVariable: DebugProtocol.Variable = {
  //     name: v.name,
  //     value: '???',
  //     type: typeof v.value,
  //     variablesReference: 0,
  //     evaluateName: '$' + v.name
  //   };

  //   if (v.name.indexOf('lazy') >= 0) {
  //     // a "lazy" variable needs an additional click to retrieve its value

  //     dapVariable.value = 'lazy var';    // placeholder value
  //     v.reference ??= this._variableHandles.create(new RuntimeVariable('', [ new RuntimeVariable('', v.value) ]));
  //     dapVariable.variablesReference = v.reference;
  //     dapVariable.presentationHint = { lazy: true };
  //   } else {

  //     if (Array.isArray(v.value)) {
  //       dapVariable.value = 'Object';
  //       v.reference ??= this._variableHandles.create(v);
  //       dapVariable.variablesReference = v.reference;
  //     } else {

  //       switch (typeof v.value) {
  //         case 'number':
  //           if (Math.round(v.value) === v.value) {
  //             dapVariable.value = this.formatNumber(v.value);
  //             (<any>dapVariable).__vscodeVariableMenuContext = 'simple';  // enable context menu contribution
  //             dapVariable.type = 'integer';
  //           } else {
  //             dapVariable.value = v.value.toString();
  //             dapVariable.type = 'float';
  //           }
  //           break;
  //         case 'string':
  //           dapVariable.value = `"${v.value}"`;
  //           break;
  //         case 'boolean':
  //           dapVariable.value = v.value ? 'true' : 'false';
  //           break;
  //         default:
  //           dapVariable.value = typeof v.value;
  //           break;
  //       }
  //     }
  //   }

  //   if (v.memory) {
  //     v.reference ??= this._variableHandles.create(v);
  //     dapVariable.memoryReference = String(v.reference);
  //   }

  //   return dapVariable;
  // }

  // private formatAddress(x: number, pad = 8) {
  //   return 'mem' + (this._addressesInHex ? '0x' + x.toString(16).padStart(8, '0') : x.toString(10));
  // }

  // private formatNumber(x: number) {
  //   return this._valuesInHex ? '0x' + x.toString(16) : x.toString(10);
  // }

  // private createSource(filePath: string): Source {
  //   return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
  // }

  /**
   * Cleans up the file name by normalizing paths and handling platform-specific quirks.
   * @param fileName - The file name to clean up.
   * @returns A cleaned-up file path.
   */
  private cleanupFileName(fileName: string): string {
    let cleanFilePath = fileName;

    /** Gdb running on windows often delivers "fullnames" which
     * (a) have no drive letter and (b) are not normalized.
     */
    if (process.platform === 'win32') {
      if (!fileName) {
        return '';
      }
      cleanFilePath = path.normalize(fileName);
    }

    return cleanFilePath;
  }

  private isMetaModelicaSource(fileName: string): boolean {
    return path.extname(fileName).toLowerCase() === ".mo";
  }

  private threadDisplayName(threadId: string, targetId: string, frame?: GDBMITuple): string {
    const lwpMatch = /\(LWP ([^)]+)\)/.exec(targetId);
    const threadName = lwpMatch ? `Thread ${threadId} LWP ${lwpMatch[1]}` : `Thread ${threadId}`;

    if (!frame) {
      return targetId ? `${threadName} ${targetId}` : threadName;
    }

    const fileResult = this.gdbAdapter.getGDBMIResult("file", frame.miResultsList);
    const file = fileResult ? this.cleanupFileName(this.gdbAdapter.getGDBMIConstantValue(fileResult)) : "";
    const fullnameResult = this.gdbAdapter.getGDBMIResult("fullname", frame.miResultsList);
    const fullname = fullnameResult ? this.gdbAdapter.getGDBMIConstantValue(fullnameResult) : "";
    const sourcePath = fullname || file;

    const funcResult = this.gdbAdapter.getGDBMIResult("func", frame.miResultsList);
    const func = funcResult ? this.cleanupFunction(this.gdbAdapter.getGDBMIConstantValue(funcResult), sourcePath) : "";
    const lineResult = this.gdbAdapter.getGDBMIResult("line", frame.miResultsList);
    const line = lineResult ? this.gdbAdapter.getGDBMIConstantValue(lineResult) : "";

    if (this.isMetaModelicaSource(sourcePath) && func) {
      const location = line ? `${path.basename(sourcePath)}:${line}` : path.basename(sourcePath);
      return `${threadName}: ${func} (${location})`;
    }

    return targetId ? `${threadName} ${targetId}` : threadName;
  }

  /**
   * Cleans up a function name based on the file extension and specific naming conventions.
   *
   * - If the file extension is `.mo`:
   *   - Removes the `omc_` prefix from the function name if it exists.
   *   - Converts function names starting with `_omcQuot_` from a hex-encoded string to a readable string.
   *
   * @param functionName - The original name of the function to be cleaned.
   * @param fileName - The name of the file associated with the function, used to determine the file extension.
   * @returns The cleaned-up function name.
   */
  private cleanupFunction(functionName: string, fileName: string): string {
    let cleanFunction = functionName;
    const fileExtension = path.extname(fileName).toLowerCase();

    if (fileExtension === '.mo') {
      // If the function name starts with 'omc_', remove the first 4 characters
      if (functionName.startsWith('omc_')) {
        cleanFunction = functionName.substring(4);
      } else if (functionName.startsWith('_omcQuot_')) { // If the names are converted to hex values
        const hexString = this.omcHexToString(functionName);
        if (hexString) {
          cleanFunction = hexString;
        }
      }
      const underscorePlaceholder = "__MM_UNDERSCORE__";
      cleanFunction = cleanFunction
        .replace(/_5[fF]/g, underscorePlaceholder)
        .replace(/_/g, ".")
        .replace(new RegExp(underscorePlaceholder, "g"), "_");
    }

    return cleanFunction;
  }

  /** todo. Fix this code */
  private omcHexToString(str: string): string | null {
    const lookupTbl = '0123456789ABCDEF';
    const omcQuotPrefix = '_omcQuot_';

    if (!str.startsWith("'") || !str.endsWith("'")) {
      return null;
    }

    const hexContent = str.slice(1, -1); // Remove the surrounding single quotes
    let result = omcQuotPrefix;

    for (const char of hexContent) {
      const charCode = char.charCodeAt(0);
      result += lookupTbl[Math.floor(charCode / 16)] + lookupTbl[charCode % 16];
    }

    return result;
  }
}
