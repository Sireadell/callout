// Browser preview only. Stands in for the Even Hub SDK so the real glasses app code can run on a
// web page: the same names and values, with a bridge that draws on the page instead of the lens.
const numbered = (names) => Object.freeze(Object.fromEntries(names.map((n, i) => [n, i])));

export const OsEventTypeList = numbered(['CLICK_EVENT', 'SCROLL_TOP_EVENT', 'SCROLL_BOTTOM_EVENT', 'DOUBLE_CLICK_EVENT', 'FOREGROUND_ENTER_EVENT', 'FOREGROUND_EXIT_EVENT', 'ABNORMAL_EXIT_EVENT', 'SYSTEM_EXIT_EVENT', 'IMU_DATA_REPORT', 'LONG_PRESS_EVENT', 'LONG_PRESS_RELEASE_EVENT']);
export const EventSourceType = numbered(['TOUCH_EVENT_FORM_DUMMY_NULL', 'TOUCH_EVENT_FROM_GLASSES_R', 'TOUCH_EVENT_FROM_RING', 'TOUCH_EVENT_FROM_GLASSES_L']);
export const StartUpPageCreateResult = numbered(['success', 'invalid', 'oversize', 'outOfMemory']);
export const DeviceConnectType = Object.freeze({ None: 'none', Connecting: 'connecting', Connected: 'connected', Disconnected: 'disconnected', ConnectionFailed: 'connectionFailed' });
export const AudioInputSource = Object.freeze({ Glasses: 'glasses', Phone: 'phone' });
export const AudioSpeakerRole = Object.freeze({ Self: 'self', Other: 'other', Unknown: 'unknown' });
export const ImuReportPace = Object.freeze({ P100: 100, P1000: 1000 });

// The page puts its bridge here before it loads the app.
export const waitForEvenAppBridge = async () => globalThis.__lensBridge;
