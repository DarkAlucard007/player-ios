// v1.1.25：ObjC 异常护栏。
// FileHandle 的非 throwing 重载（readData(ofLength:) 不带 try 时选中的那个）
// 在 SMB/LiveFiles 读取失败时抛的是 NSException（NSFileHandleOperationException），
// Swift 的 do/catch 接不住 → 未捕获 NSException → SIGABRT 闪退（.ips 实锤，
// 崩溃栈 closure #1 in LocalMediaPlugin.stream ← objc_exception_throw）。
// 用 C API 包装 @try/@catch，任何残留 NSException 都变成干净的 false 返回。
#import <Foundation/Foundation.h>

#ifdef __cplusplus
extern "C" {
#endif

/// 执行 block；若抛出任何 ObjC 异常则吞掉并返回 false，正常完成返回 true。
bool localmedia_runGuarded(void (^block)(void));

#ifdef __cplusplus
}
#endif
