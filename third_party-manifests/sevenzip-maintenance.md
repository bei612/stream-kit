# 7z 解析器源码维护

权威源码位于 `third_party/sevenzip`，来源、版本、提交、Go 校验值和许可证见 `sevenzip.json`。保留完整模块发布内容，包括上游测试与压缩包样例；不是 submodule。

Orchestrator 的 `go.mod` 使用本地 replace。现有生产构建采用已纳管的 vendor，因此修改权威源码后必须在 `orchestrator` 执行 `go mod vendor` 并提交生成差异，不直接修改 vendor 中的副本。运行应用包归档测试与全量 Go 测试；上游测试在 `third_party/sevenzip` 中执行 `go test ./...`。

当前只完成源码纳管和依赖接线，尚未改变解析器。后续资源预算必须在分配前约束文件表、属性、压缩头与解码器字典，并为普通头、压缩头、solid 压缩及异常计数补充回归。不得将输出文件限额或本次源码复制当作解析内存限制已经完成。
