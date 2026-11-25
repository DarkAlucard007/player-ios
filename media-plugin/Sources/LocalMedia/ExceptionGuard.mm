#import "ExceptionGuard.h"

bool localmedia_runGuarded(void (^block)(void)) {
    @try {
        block();
        return true;
    } @catch (NSException *exception) {
        // 异常详情无法从这里安全取出（本身可能再抛），只返回 false。
        (void)exception;
        return false;
    }
}
