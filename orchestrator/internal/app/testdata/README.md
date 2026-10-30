# Archive fixtures

`plain-header.7z` and `compressed-header.7z` are the `t0.7z` and `t1.7z` fixtures from [bodgit/sevenzip v1.6.5](https://github.com/bodgit/sevenzip/tree/v1.6.5/testdata), with its BSD license in `sevenzip.LICENSE`. They exercise real 7z decoding with plain and compressed headers.

ZIP, TAR, compressed TAR and stored RAR 4 samples are generated in `archive_test.go`; no external archiver is required to run the tests. The RAR fixture follows the [public RAR format specification](https://www.rarlab.com/technote.htm).

`application.tar.bz2` was generated with the Windows-provided `tar.exe -cjf`. It contains only `game.bin` with the seven UTF-8 bytes `payload` and modification timestamp zero.
