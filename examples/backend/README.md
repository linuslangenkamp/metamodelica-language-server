# Backend Debugging Smoke Test

These scripts debug the OpenModelica compiler backend itself. VS Code launches
`omc` under GDB and passes one of the `.mos` scripts as input.

Good first new-backend breakpoints:

- `OMCompiler/Compiler/SimCode/SimCodeMain.mo:1593`
- `OMCompiler/Compiler/NBackEnd/Classes/NBackendDAE.mo:336`
- `OMCompiler/Compiler/NBackEnd/Classes/NBackendDAE.mo:337`
- `OMCompiler/Compiler/NBackEnd/Classes/NBackendDAE.mo:338`

Good first classic-backend breakpoints:

- `OMCompiler/Compiler/SimCode/SimCodeMain.mo:1406`
- `OMCompiler/Compiler/BackEnd/BackendDAECreate.mo:138`
- `OMCompiler/Compiler/BackEnd/BackendDAEUtil.mo:7645`

When stopped, use Debug Console commands such as:

```text
print bdae
mm.type bdae
mm.probe cref
mm.probe comps[i]
mm.print comps[i]
mm.string NBackendDAE.toString(bdae, "debug bdae")
call BackendDump.dumpBackendDAE(dae, "debug dae")
mm.print NFComponentRef.toString(seed_vars[1])
mm.print NFComponentRef.toString(@cref)
mm.print UnorderedSet.toString(seed_set, NFComponentRef.toString)
```

Use `@name` for generated locals that GDB shows as raw untagged
MetaModelica pointers. Use `@*name` only for pointer-to-slot values.
Source-style indexing such as `comps[i]` is rewritten to generated locals and
runtime array/list getters before GDB evaluates it.
Primitive container callbacks such as `intString`, `realString`, and
`boolString` are supported directly; string elements can use `Util.id`.
