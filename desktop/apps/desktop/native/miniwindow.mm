#include <node_api.h>

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>

namespace {

void throwTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
}

NSWindow* windowFromHandle(napi_env env, napi_value value) {
  bool isBuffer = false;
  if (napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer) {
    throwTypeError(env, "Expected an Electron native window handle Buffer");
    return nil;
  }

  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok || length < sizeof(void*)) {
    throwTypeError(env, "Native window handle Buffer is invalid");
    return nil;
  }

  uintptr_t viewAddress = 0;
  std::memcpy(&viewAddress, data, sizeof(viewAddress));
  NSView* view = (__bridge NSView*)(reinterpret_cast<void*>(viewAddress));
  return view.window;
}

std::string stringFromValue(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    throwTypeError(env, "Expected an icon file path");
    return {};
  }

  std::string result(length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, result.data(), result.size(), &copied) != napi_ok) {
    throwTypeError(env, "Could not read icon file path");
    return {};
  }
  result.resize(copied);
  return result;
}

NSImage* snapshotForWindow(NSWindow* window) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CGImageRef windowImage = CGWindowListCreateImage(
      CGRectNull,
      kCGWindowListOptionIncludingWindow,
      static_cast<CGWindowID>(window.windowNumber),
      kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution);
#pragma clang diagnostic pop
  if (windowImage) {
    NSImage* snapshot = [[NSImage alloc] initWithCGImage:windowImage size:NSZeroSize];
    CGImageRelease(windowImage);
    return snapshot;
  }

  NSView* contentView = window.contentView;
  if (!contentView) return nil;

  NSRect bounds = contentView.bounds;
  if (NSIsEmptyRect(bounds)) return nil;

  NSBitmapImageRep* bitmap = [contentView bitmapImageRepForCachingDisplayInRect:bounds];
  if (!bitmap) return nil;
  [contentView cacheDisplayInRect:bounds toBitmapImageRep:bitmap];

  NSImage* snapshot = [[NSImage alloc] initWithSize:bounds.size];
  [snapshot addRepresentation:bitmap];
  return snapshot;
}

NSRect aspectFitRect(NSSize sourceSize, NSRect targetRect) {
  if (sourceSize.width <= 0 || sourceSize.height <= 0) return targetRect;
  const CGFloat scale = std::min(targetRect.size.width / sourceSize.width,
                                 targetRect.size.height / sourceSize.height);
  const NSSize size = NSMakeSize(sourceSize.width * scale, sourceSize.height * scale);
  return NSMakeRect(NSMidX(targetRect) - size.width / 2,
                    NSMidY(targetRect) - size.height / 2,
                    size.width,
                    size.height);
}

NSImage* composeMiniwindowImage(NSImage* snapshot, NSImage* appIcon) {
  const NSSize canvasSize = NSMakeSize(256, 256);
  NSImage* result = [[NSImage alloc] initWithSize:canvasSize];
  [result lockFocus];

  [[NSColor clearColor] setFill];
  NSRectFillUsingOperation(NSMakeRect(0, 0, canvasSize.width, canvasSize.height),
                           NSCompositingOperationCopy);

  const NSRect previewBounds = NSMakeRect(8, 24, 240, 220);
  const NSRect previewRect = aspectFitRect(snapshot.size, previewBounds);
  [snapshot drawInRect:previewRect
              fromRect:NSZeroRect
             operation:NSCompositingOperationSourceOver
              fraction:1.0
        respectFlipped:YES
                 hints:@{NSImageHintInterpolation: @(NSImageInterpolationHigh)}];

  [NSGraphicsContext saveGraphicsState];
  NSShadow* shadow = [[NSShadow alloc] init];
  shadow.shadowColor = [NSColor colorWithWhite:0 alpha:0.24];
  shadow.shadowBlurRadius = 5;
  shadow.shadowOffset = NSMakeSize(0, -1);
  [shadow set];
  [appIcon drawInRect:NSMakeRect(184, 8, 64, 64)
             fromRect:NSZeroRect
            operation:NSCompositingOperationSourceOver
             fraction:1.0
       respectFlipped:YES
                hints:@{NSImageHintInterpolation: @(NSImageInterpolationHigh)}];
  [NSGraphicsContext restoreGraphicsState];

  [result unlockFocus];
  return result;
}

const void* kMiniwindowObserverKey = &kMiniwindowObserverKey;

napi_value installMiniwindowCustomization(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 2) {
    throwTypeError(env, "Expected a native window handle and icon path");
    return nullptr;
  }

  NSWindow* window = windowFromHandle(env, args[0]);
  if (!window) return nullptr;
  const std::string iconPath = stringFromValue(env, args[1]);
  if (iconPath.empty()) return nullptr;

  @autoreleasepool {
    if (objc_getAssociatedObject(window, kMiniwindowObserverKey)) {
      napi_value result;
      napi_get_boolean(env, true, &result);
      return result;
    }

    NSImage* appIcon = [[NSImage alloc] initWithContentsOfFile:
        [NSString stringWithUTF8String:iconPath.c_str()]];
    if (!appIcon) {
      napi_value result;
      napi_get_boolean(env, false, &result);
      return result;
    }

    id observer = [[NSNotificationCenter defaultCenter]
        addObserverForName:NSWindowWillMiniaturizeNotification
                    object:window
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification* notification) {
      NSWindow* targetWindow = notification.object;
      NSImage* snapshot = snapshotForWindow(targetWindow);
      if (!snapshot) return;
      targetWindow.miniwindowImage = composeMiniwindowImage(snapshot, appIcon);
      targetWindow.dockTile.showsApplicationBadge = NO;
      [targetWindow.dockTile display];
    }];
    objc_setAssociatedObject(window, kMiniwindowObserverKey, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "installMiniwindowCustomization", NAPI_AUTO_LENGTH, installMiniwindowCustomization, nullptr, &function);
  napi_set_named_property(env, exports, "installMiniwindowCustomization", function);
  return exports;
}
