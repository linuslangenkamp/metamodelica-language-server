# Backend Debugger Workflow

Minimal workflow for OpenModelica backend developers debugging the compiler with
the MetaModelica debugger from this extension.

## Prerequisites

- Open the OpenModelica checkout as the workspace root.
- Build `omc` with debug information.
- Have `gdb` on `PATH`.
- Have a `metamodelica-language-server-0.3.0.vsix` or newer VSIX.

The launch examples below assume:

```text
${workspaceFolder}/build_cmake/install_cmake/bin/omc
```

Change `program` if your `omc` is elsewhere.

## Install The Extension

VS Code:

```bash
code --install-extension metamodelica-language-server-0.3.0.vsix --force
```

VSCodium:

```bash
codium --install-extension metamodelica-language-server-0.3.0.vsix --force
```

Then run `Developer: Reload Window`.

Verify the installed extension:

```bash
code --list-extensions --show-versions | grep -i metamodelica
codium --list-extensions --show-versions | grep -i metamodelica
```

Expected extension id:

```text
openmodelica.metamodelica-language-server@0.3.0
```

## Minimal Model And Script

Create a small debug directory in the OpenModelica checkout:

```bash
mkdir -p .debug/metamodelica-backend
```

Create `.debug/metamodelica-backend/BackendSmoke.mo`:

```modelica
model BackendSmoke
  Real x(start = 1);
equation
  der(x) = -x;
end BackendSmoke;
```

Create `.debug/metamodelica-backend/debug-backend-new.mos`:

```modelica
echo(true);
setCommandLineOptions("--newBackend"); getErrorString();
loadFile("BackendSmoke.mo"); getErrorString();
translateModel(BackendSmoke); getErrorString();
```

## Launch Configuration

Create `.vscode/launch.json` in the OpenModelica checkout:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug omc new backend smoke test",
      "type": "metamodelica-dbg",
      "request": "launch",
      "gdb": "gdb",
      "program": "${workspaceFolder}/build_cmake/install_cmake/bin/omc",
      "arguments": [
        "${workspaceFolder}/.debug/metamodelica-backend/debug-backend-new.mos"
      ],
      "cwd": "${workspaceFolder}/.debug/metamodelica-backend",
      "logLevel": "info",
      "showRuntimeLocals": false,
      "printElements": 10000,
      "autoPrettyPrint": false,
      "autoPrettyMaxLength": 240,
      "autoPrettyMaxCollectionLength": 25,
      "autoPrettyMaxPerRequest": 40,
      "lazyPrettyMaxLength": 12000,
      "maxIndexedChildren": 100
    }
  ]
}
```

## Run A Debug Session

1. Open `OMCompiler/Compiler/SimCode/SimCodeMain.mo`.
2. Set a breakpoint in `translateModelCallBackendNB`, for example near:
   `bdae := NBackendDAE.lower(inFlatModel, funcMap);`
3. Open `OMCompiler/Compiler/NBackEnd/Classes/NBackendDAE.mo`.
4. Set a breakpoint in `NBackendDAE.main`, for example near:
   `(bdae, mainClocks) := applyModules(...)`.
5. Select `Debug omc new backend smoke test` in Run and Debug.
6. Press `F5`.

The debugger should stop in MetaModelica `.mo` source frames.

## Inspect Backend Values

Use the Variables view first:

- Locals are lazy. Top-level values use cheap labels like
  `record<...> (expand for fields)`.
- Expand a value to inspect fields, lists, tuples, options, arrays, records, and
  container internals.
- If a value has a safe conventional printer, it gets a lazy `[pretty]` child.
  Expand `[pretty]` only when you want to run the printer.
- `UnorderedSet`, `UnorderedMap`, `Vector`, `ExpandableArray`, and
  `DoubleEnded.MutableList` are shown structurally. Their generic `toString`
  functions are not called automatically.

Useful Debug Console commands:

```text
print bdae
mm.type bdae
mm.probe cref
mm.probe comps[i]
mm.print comps[i]
pp bdae using NBackendDAE.toString
mm.string NBackendDAE.toString(bdae, "debug bdae")
mm.string NBJacobian.toString(jacobian, "")
pp crefs using NFComponentRef.listToString
mm.print NFComponentRef.toString(seed_vars[1])
mm.print NFComponentRef.toString(@cref)
mm.print map
mm.print UnorderedMap.toString(map, NFComponentRef.toString, NFComponentRef.listToString)
mm.print UnorderedSet.toString(seed_set, NFComponentRef.toString)
mm.print UnorderedSet.toString(int_set, intString)
mm.print UnorderedSet.toString(string_set, Util.id)
call BackendDump.dumpBackendDAE(dae, "debug dae")
gdb bt
```

Notes:

- Use `print EXPR` for the normal path.
- Use `mm.string ...` only for explicit stringification; output can be large.
- If a generated iterator local is shown as a raw C integer in Variables, use
  `@iteratorName` in a dotted call to force a `modelica_metatype` cast. This
  adds the normal RML pointer tag when GDB exposes an untagged object pointer.
- Source-style local names and indexing are normalized before GDB sees them.
  For example, `comps[i]` resolves to generated locals and uses the runtime
  array getter. List indexing such as `values[1]` uses the runtime list getter.
- Use `@*slotName` only when the local is a pointer to a slot containing the
  MetaModelica value. Use `mm.probe name` to see the raw GDB value and `@`
  interpretation before guessing.
- Some pretty-printers take an accumulator string. Use an explicit empty string,
  for example `mm.string NBJacobian.toString(jacobian, "")`.
- `mm.print map` and `mm.print set` handle `UnorderedMap`/`UnorderedSet`
  structurally and are bounded by `maxIndexedChildren`. Explicit generic
  container printers are intercepted and applied element-by-element, e.g.
  `UnorderedSet.toString(seed_set, NFComponentRef.toString)` and
  `UnorderedMap.toString(map, NFComponentRef.toString, NFComponentRef.listToString)`.
- Primitive callback names are supported directly: `intString`, `realString`,
  and `boolString`. For string elements, use `Util.id`.
- Expanding `UnorderedSet`, `UnorderedMap`, `Vector`, `ExpandableArray`, or
  `DoubleEnded.MutableList` adds structural `[elements]`, `[entries]`, `[keys]`,
  or `[values]` children where available.
- Raise `maxIndexedChildren` in `launch.json` if you want more than the first
  100 indexed list/array/tuple entries per expansion.

## Common Problems

- Breakpoints do not bind: reload VS Code/VSCodium after installing the VSIX and
  check that `.mo` files use the `MetaModelica` language mode.
- The wrong debugger starts: check `"type": "metamodelica-dbg"` in
  `launch.json`.
- Locals are slow: keep `"autoPrettyPrint": false` and avoid expanding huge
  recursive values unless needed.
- `omc` is not found: set `program` to the absolute `omc` path.
- VSCodium cannot find the extension: install the VSIX with `codium
  --install-extension ... --force`, then reload the window.

## Build A VSIX From This Repository

For extension maintainers:

```bash
npm ci
npm run test-compile
npm run esbuild
npx @vscode/vsce package
```

Install the generated VSIX with `code --install-extension` or
`codium --install-extension`.
