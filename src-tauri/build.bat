call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set LIBCLANG_PATH=C:\temp\llvm2\clang+llvm-18.1.8-x86_64-pc-windows-msvc\bin
set PATH=%PATH%;C:\Users\aryab\.cargo\bin;C:\temp\cmake\cmake-3.29.3-windows-x86_64\bin
set CMAKE_GENERATOR=NMake Makefiles
cargo build
