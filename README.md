# MetaModelica Language Server

[![Build](https://github.com/OpenModelica/metamodelica-language-server/actions/workflows/test.yml/badge.svg)](https://github.com/OpenModelica/metamodelica-language-server/actions/workflows/test.yml)

A very early version of a MetaModelica Language Server based on
[OpenModelica/tree-sitter-metamodelica](https://github.com/OpenModelica/tree-sitter-metamodelica).

For syntax highlighting install extension
[AnHeuermann.metamodelica](https://marketplace.visualstudio.com/items?itemName=AnHeuermann.metamodelica)
in addition.

## Functionality

This Language Server works for MetaModelica files. It has the following language
features:

- Provide Outline of MetaModelica files.

  ![Outline](images/outline_demo.png)

- Diagnostics:

  ![Diagnostics](images/problemMatching.png)

## Debugging The OpenModelica Compiler

The extension also contributes a MetaModelica debugger for the OpenModelica
compiler backend. It launches `omc` under GDB, uses the compiler debug line
mappings to stop in MetaModelica `.mo` sources, and exposes MetaModelica values
through the same runtime primitives used by the OpenModelica debugger helpers.

The debugger type is:

```json
"type": "metamodelica-dbg"
```

Example launch configuration for an OpenModelica checkout:

```json
{
  "name": "Debug omc new backend smoke test",
  "type": "metamodelica-dbg",
  "request": "launch",
  "gdb": "gdb",
  "program": "${workspaceFolder}/build_cmake/install_cmake/bin/omc",
  "arguments": [
    "${workspaceFolder}/OMCompiler/tools/vscode/metamodelica-debugger/examples/backend/debug-backend-new.mos"
  ],
  "cwd": "${workspaceFolder}/OMCompiler/tools/vscode/metamodelica-debugger/examples/backend",
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
```

When stopped at a backend breakpoint, useful Debug Console commands are:

```text
print bdae
mm.type bdae
mm.probe cref
mm.probe comps[i]
mm.print comps[i]
mm.string NBackendDAE.toString(bdae, "debug bdae")
pp bdae using NBackendDAE.toString
pp crefs using NFComponentRef.listToString
mm.print NFComponentRef.toString(seed_vars[1])
call BackendDump.dumpBackendDAE(dae, "debug dae")
gdb bt
```

`print` tries conventional MetaModelica pretty-printers first, then falls back
to structural output. For example, `print crefs` on a
`list<record<NFComponentRef.CREF>>` value tries `NFComponentRef.listToString`.
Primitive values are shown directly, while records, lists, options, tuples, and
arrays without a matching pretty-printer are returned as expandable values.
Lists include both `head`/`tail` entries and indexed entries, so large lists can
be traversed one cons cell at a time.

Use `pp EXPR using FUNCTION` to call a custom MetaModelica pretty-printer with
one argument, or `mm.string Some.toString(expr, extraArgs...)` for explicit
calls. Some `toString` functions take an extra accumulator string; call those
with `""`, for example `mm.string NBJacobian.toString(jacobian, "")`. Full
`anyString` stringification is only done through explicit pretty-print commands,
since blindly printing arbitrary MetaModelica graphs can produce very large
output or run into cyclic structures. Use `call` for dump functions that print
as a side effect.

Generated C locals may expose a MetaModelica value as an untagged raw pointer.
Use `@name` for that case, for example
`mm.print NFComponentRef.toString(@cref)`. Use `@*name` only if the local is a
real pointer to a slot that contains the value. `mm.probe name` prints the raw
GDB value, the `@` rewrite, and the detected MetaModelica type.
Source-style local names and indexing are normalized before GDB sees them, so
`comps[i]` becomes a runtime array access using generated locals like `_comps`
and `_i`. For lists, `values[1]` uses the runtime list getter.

The Variables view is structural by default so locals remain responsive even for
large or recursive backend values. The top-level value column uses cheap static
labels; record/list/array/tuple/option counts are computed only when the value is
expanded. Records expand into fields, lists expand into `head`/`tail` plus
indexed entries, and arrays/tuples/options expand into their elements. Values
with a conventional pretty-printer get a lazy `[pretty]` child; expand that child
to run `Module.toString(value)` or
`Module.listToString(values)` just for that value. For example,
`list<record<NFComponentRef.CREF>>` gets a lazy child that tries
`NFComponentRef.listToString`. The lazy output is split into line/chunk children
and capped by `lazyPrettyMaxLength`.

Generic utility containers are handled structurally. `mm.print map` and
`mm.print set` print bounded `UnorderedMap`/`UnorderedSet` contents directly
from their key/value arrays, and automatically tries conventional element
printers such as `NFComponentRef.toString` and `NFComponentRef.listToString`
from the element runtime type. This avoids passing generic `boxvar_*`
callbacks through GDB. When those values are expanded, the debugger adds cheap
computed summary rows for known containers, including `UnorderedSet`,
`UnorderedMap`, `Vector`, `ExpandableArray`, and `DoubleEnded.MutableList`,
then adds synthetic structural children such as `[elements]`, `[entries]`,
`[keys]`, and `[values]` for on-demand expansion before showing the underlying
fields.

For explicit generic container printing, pass the element callbacks. The
debugger intercepts these calls and applies the callback per element:

```text
mm.print map
mm.print UnorderedSet.toString(cref_set, NFComponentRef.toString)
mm.print UnorderedMap.toString(map, NFComponentRef.toString, NFComponentRef.listToString)
mm.print UnorderedMap.toString(map, AbsynUtil.pathString, NFFunction.Function.toString)
mm.print UnorderedSet.toString(int_set, intString)
mm.print UnorderedSet.toString(real_set, realString)
mm.print UnorderedSet.toString(bool_set, boolString)
mm.print UnorderedSet.toString(string_set, Util.id)
```

`autoPrettyPrint` can still be enabled to put short previews directly in the
value column, but it is disabled by default because backend `toString` functions
can walk large or recursive graphs. With eager previews enabled,
`autoPrettyMaxLength` truncates long strings, `autoPrettyMaxCollectionLength`
skips obvious large direct collections, and `autoPrettyMaxPerRequest` caps how
many preview calls one Variables request can make. `maxIndexedChildren` caps how
many indexed list/array/tuple elements one expansion shows before adding a
truncation row.

The Variables view also has a context action: right-click a variable and select
**Pretty Print MetaModelica Value**. This writes the same forced pretty output as
`print EXPR` to the Debug Console without expanding the whole value in the
Variables tree.

The development smoke model and scripts live in
[`examples/backend`](examples/backend).

A minimal install-and-run guide for backend developers is available in
[`docs/backend-debugger-workflow.md`](docs/backend-debugger-workflow.md).

## CLI (`mmlsc`)

The package ships a command-line tool, `mmlsc`, for batch-processing MetaModelica
source files without opening VS Code.

### Usage

```text
mmlsc [--fix] [--check <name>]... <paths...>
```

| Argument / option | Description |
| ----------------- | ----------- |
| `<paths...>` | Files or directories to process. Directories are scanned **recursively** for `.mo` files. |
| `--fix` | Apply quick-fixes **in-place** and save the modified files. Without this flag the tool only reports issues and exits with `1`. |
| `--check <name>` | Limit processing to a specific check (repeatable). When omitted all checks run. See [Supported quick-fixes](#supported-quick-fixes) for available names. |
| `--jobs N` | Process files in parallel using `N` worker threads (default: number of CPU cores; pass `1` to disable). |
| `--help` | Print usage information. |

### Example

Report all issues in a source tree:

```bash
mmlsc src/
```

Apply quick-fixes for all detected issues:

```bash
mmlsc --fix src/
```

Apply only the unused-variable fix:

```bash
mmlsc --fix --check unused-var src/
```

When installed globally (`npm install -g .` from the repository root after
building), the tool is available as `mmlsc`.

### Supported quick-fixes

| Check name | Diagnostic | Fix |
| --- | --- | --- |
| `unused-var` | Unused variable in a `protected` section or `local` block | Remove the variable declaration |
| `unused-match-arg` | Unused `match`/`matchcontinue` argument (pattern is `_` in every case) | Remove the argument from the input tuple and all case patterns |
| `unused-case-binding` | Unused binding in a `case` pattern — the bound identifier is never read in the case body | Replace the binding with `_` |
| `unused-silenced-output` | Unnecessary output silencing (`_ := expr`) — the `_ :=` prefix can be omitted | Remove the `_ :=` prefix, keeping only the expression |
| `wildcard-match` | Wildcard before `match`/`matchcontinue` (`_ := match …`) — `_` silently discards any return value; `()` is preferred because the compiler will error if a branch returns a non-unit value, catching accidental discards | Replace `_` with `()` |
| `dead-silenced-assign` | Dead assignment `_ := variable;` where the RHS is a plain variable (no side effect) | Drop the entire statement |
| `redundant-parens` | Single-element parentheses in a `match` input, `case` pattern, or assignment LHS | Unwrap the parentheses |
| `wildcard-tuple` | All-wildcard tuple pattern `(_, _, _)` nested inside a `case` pattern — every element is already a wildcard | Collapse to a single `_` |

## Installation

### Via Marketplace

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=OpenModelica.metamodelica-language-server)
- [Open VSX Registry](https://open-vsx.org/extension/OpenModelica/metamodelica-language-server)

### Via VSIX File

Download the latest
[metamodelica-language-server-0.3.0.vsix](https://github.com/OpenModelica/metamodelica-language-server/releases/download/v0.3.0/metamodelica-language-server-0.3.0.vsix)
from the
[releases](https://github.com/OpenModelica/metamodelica-language-server/releases)
page.

Check the [VS Code documentation](https://code.visualstudio.com/docs/editor/extension-marketplace#_install-from-a-vsix)
on how to install a .vsix file.
Use the `Install from VSIX` command or run

```bash
code --install-extension metamodelica-language-server-0.3.0.vsix
```

## Contributing ❤️

Contributions are very welcome!

We made the first tiny step but need help to add more features and refine the
language server.

If you are searching for a good point to start
check the
[good first issue](https://github.com/OpenModelica/metamodelica-language-server/labels/good%20first%20issue).
To see where the development is heading to check the
[Projects section](https://github.com/OpenModelica/metamodelica-language-server/projects?query=is%3Aopen).
If you need more information start a discussion over at
[OpenModelica/OpenModelica](https://github.com/OpenModelica/OpenModelica).

Found a bug or having issues? Open a
[new issue](https://github.com/OpenModelica/metamodelica-language-server/issues/new/choose).

## Build

### Dependencies

- Node.js >= 22

### Quick install

```bash
npm install
npm run esbuild
```

### VS Code

- Open VS Code on this folder.
- Press ``Ctrl+Shift+B`` to start compiling the client and server.
- Switch to the Run and Debug View in the Sidebar (`Ctrl+Shift+D`).
- Select `Launch Client` from the drop down (if it is not already).
- Press ▷ to run the launch config (`F5`).
- Both build task and launch are available in [watch
  mode](https://code.visualstudio.com/docs/editor/tasks#:~:text=The%20first%20entry%20executes,the%20HelloWorld.js%20file.)
- In the [Extension Development
  Host](https://code.visualstudio.com/api/get-started/your-first-extension#:~:text=Then%2C%20inside%20the%20editor%2C%20press%20F5.%20This%20will%20compile%20and%20run%20the%20extension%20in%20a%20new%20Extension%20Development%20Host%20window.)
  instance of VSCode, open a document in `'metamodelica'` language mode.
  - Check the console output of `MetaModelica Language Server` to see the parsed
    tree of the opened file.

## Testing

The test suite runs inside a VS Code instance (via [`@vscode/test-electron`](https://github.com/microsoft/vscode-test)) and requires a display. It also exercises the GDB adapter, so `gdb` and `omc` must be on `PATH`.

### Prerequisites

- Node.js >= 22
- `gdb`
- `omc` (OpenModelica Compiler)
- A display server — on a headless machine use `xvfb`

### Running the tests

Build the extension first, then run the suite:

```bash
npm install
npm run esbuild
npm test
```

On a headless machine (e.g. WSL2 without WSLg, or a CI server) provide a
virtual display with `xvfb-run`:

```bash
sudo apt-get install -y xvfb gdb
xvfb-run -a npm test
```

This is equivalent to what the CI workflow does.

## Build and Install Extension

```bash
npx vsce package
```

## License

**metamodelica-language-server** is licensed under the OSMC Public License v1.8, see
[License.txt](./License.txt).

### 3rd Party Licenses

This extension is based on
[https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample),
licensed under MIT license.

Some parts of the source code are taken from
[bash-lsp/bash-language-server](https://github.com/bash-lsp/bash-language-server),
licensed under the MIT license and adapted to the MetaModelica language server.

The debugger is based on [microsoft/vscode-mock-debug](https://github.com/microsoft/vscode-mock-debug) licensed under MIT.

[OpenModelica/tree-sitter-metamodelica](https://github.com/OpenModelica/tree-sitter-metamodelica)
is included in this extension and is licensed under the [OSMC-PL
v1.8](./server/License.txt).

## Acknowledgments

This package was initially developed by
[Hochschule Bielefeld - University of Applied Sciences and Arts](hsbi.de).
