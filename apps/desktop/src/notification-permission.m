#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

// Node-API 的稳定 C ABI；该模块只使用字符串和函数导出。
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_create_string_utf8(napi_env, const char *, size_t, napi_value *);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);

static napi_value permission(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block BOOL denied = NO;
    [[UNUserNotificationCenter currentNotificationCenter]
        getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
          denied = settings.authorizationStatus == UNAuthorizationStatusDenied;
          dispatch_semaphore_signal(done);
        }];
    BOOL timeout = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC)) != 0;
    napi_value result;
    napi_create_string_utf8(env, timeout ? "unknown" : denied ? "denied" : "available", (size_t)-1, &result);
    return result;
  }
}

__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) { return 8; }
__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "getStatus", (size_t)-1, permission, NULL, &function);
  napi_set_named_property(env, exports, "getStatus", function);
  return exports;
}
