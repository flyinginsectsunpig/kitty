"""Regenerates src/kitty_ai/contracts from contracts/proto (committed; CI checks it is up to date)."""

import pathlib
import shutil

import grpc_tools
from grpc_tools import protoc

ROOT = pathlib.Path(__file__).resolve().parents[3]
PROTO = ROOT / "contracts" / "proto"
OUT = pathlib.Path(__file__).resolve().parents[1] / "src" / "kitty_ai" / "contracts"

shutil.rmtree(OUT, ignore_errors=True)
OUT.mkdir(parents=True)
includes = pathlib.Path(grpc_tools.__file__).parent / "_proto"
files = sorted(p.relative_to(PROTO).as_posix() for p in PROTO.rglob("*.proto"))
code = protoc.main(["protoc", f"-I{PROTO}", f"-I{includes}", f"--python_out={OUT}", f"--pyi_out={OUT}", *files])
if code != 0:
    raise SystemExit(code)
for d in [OUT, *[p for p in OUT.rglob("*") if p.is_dir()]]:
    (d / "__init__.py").touch()
print(f"generated {len(files)} file(s) into {OUT}")
