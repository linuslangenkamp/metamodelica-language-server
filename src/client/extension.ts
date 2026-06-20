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

import * as path from 'path';
import * as fs from 'fs';
import { commands, debug, languages, workspace, window, ExtensionContext, TextDocument } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';
import * as DebuggerExtension from '../debugger/extension';

let client: LanguageClient;

type DebugVariableContext = {
  evaluateName?: unknown;
  expression?: unknown;
  name?: unknown;
  variable?: unknown;
  item?: unknown;
  data?: unknown;
};

function stringProperty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function printableDebugExpression(value: unknown): string | undefined {
  const expression = stringProperty(value);
  if (!expression) {
    return undefined;
  }

  if (/^(Error:|MetaModelica debug command failed\.|No conventional MetaModelica pretty-printer|\[unavailable\]|<unavailable)/.test(expression)) {
    return undefined;
  }

  return expression;
}

function debugVariableExpression(value: unknown): string | undefined {
  const visited = new Set<unknown>();
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const context = current as DebugVariableContext;
    const expression =
      printableDebugExpression(context.evaluateName) ||
      printableDebugExpression(context.expression) ||
      printableDebugExpression(context.name);
    if (expression) {
      return expression;
    }

    queue.push(context.variable, context.item, context.data);
  }

  return undefined;
}

function debugVariableLabel(value: unknown, expression: string): string {
  if (!value || typeof value !== 'object') {
    return expression;
  }

  const context = value as DebugVariableContext;
  return stringProperty(context.name) || expression;
}

export async function activate(context: ExtensionContext) {
  // Activate Debugger
  DebuggerExtension.initialize(context);

  context.subscriptions.push(commands.registerCommand('metamodelica.debug.prettyPrintVariable', async (variable?: unknown) => {
    const session = debug.activeDebugSession;
    if (!session || session.type !== 'metamodelica-dbg') {
      void window.showWarningMessage('No active MetaModelica debug session.');
      return;
    }

    const expression = debugVariableExpression(variable);
    if (!expression) {
      void window.showWarningMessage('No printable expression is available for the selected variable.');
      return;
    }

    try {
      const result = await session.customRequest('metamodelica.prettyPrintVariable', { expression });
      const label = debugVariableLabel(variable, expression);
      const text = typeof result?.result === 'string' ? result.result : String(result?.result ?? result ?? '');
      debug.activeDebugConsole.appendLine(`${label} = ${text}`);
    } catch (error) {
      void window.showErrorMessage(`MetaModelica pretty print failed: ${error}`);
    }
  }));

  // Register event listener to set language for '.mo' files.
  const checkedFiles: { [id: string]: boolean} = {};
  workspace.onDidOpenTextDocument((document: TextDocument) => {
    if (checkedFiles[document.fileName]) {
      return;
    }

    checkedFiles[document.fileName] = true;
    languages.setTextDocumentLanguage(document, 'metamodelica');
  });

  // The server is implemented in node, point to packed module
  const serverModule = context.asAbsolutePath(
    path.join('out', 'server.js')
  );
  if (!fs.existsSync(serverModule)) {
    throw new Error(`Can't find server module in ${serverModule}`);
  }

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
    }
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for metamodelica text documents
    documentSelector: [
      {
        language: 'metamodelica',
        scheme: 'file'
      }
    ],
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
    }
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    'metamodelicaLanguageServer',
    'MetaModelica Language Server',
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  await client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
