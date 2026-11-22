/// systap.rs — capture what the Mac is playing ("System audio" in Settings → Audio input).
///
/// Uses Core Audio process taps (macOS 14.2+): a global tap over every app's output
/// (LocalFlow itself excluded, so its own sounds aren't transcribed), wrapped in a
/// private aggregate device, read with an IO proc. macOS asks once for "System Audio
/// Recording" permission (NSAudioCaptureUsageDescription in Info.plist).
///
/// The tap APIs are looked up at runtime so the app still launches on older macOS,
/// where this option is simply unavailable.
use objc::runtime::{Class, Object};
use objc::{class, msg_send, sel, sel_impl};
use std::ffi::{c_void, CStr, CString};

type ObjectId = u32;
type OSStatus = i32;

#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}

const fn fourcc(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | s[3] as u32
}
const GLOBAL: u32 = fourcc(b"glob");

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct StreamDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
struct AudioBuffer {
    channels: u32,
    bytes: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    count: u32,
    buffers: [AudioBuffer; 1],
}

type IoProc = extern "C" fn(
    ObjectId,
    *const c_void,
    *const AudioBufferList,
    *const c_void,
    *mut AudioBufferList,
    *const c_void,
    *mut c_void,
) -> OSStatus;
type IoProcId = *mut c_void;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(
        id: ObjectId,
        addr: *const Address,
        qsize: u32,
        qdata: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> OSStatus;
    fn AudioHardwareCreateAggregateDevice(desc: *const c_void, out: *mut ObjectId) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(id: ObjectId) -> OSStatus;
    fn AudioDeviceCreateIOProcID(
        dev: ObjectId,
        proc_: IoProc,
        client: *mut c_void,
        out: *mut IoProcId,
    ) -> OSStatus;
    fn AudioDeviceDestroyIOProcID(dev: ObjectId, id: IoProcId) -> OSStatus;
    fn AudioDeviceStart(dev: ObjectId, id: IoProcId) -> OSStatus;
    fn AudioDeviceStop(dev: ObjectId, id: IoProcId) -> OSStatus;
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const std::os::raw::c_char) -> *mut c_void;
}
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

type CreateTap = unsafe extern "C" fn(*mut Object, *mut ObjectId) -> OSStatus;
type DestroyTap = unsafe extern "C" fn(ObjectId) -> OSStatus;

fn sym<T>(name: &str) -> Option<T> {
    let c = CString::new(name).ok()?;
    let p = unsafe { dlsym(RTLD_DEFAULT, c.as_ptr()) };
    (!p.is_null()).then(|| unsafe { std::mem::transmute_copy::<*mut c_void, T>(&p) })
}

/// Whether this Mac can capture system audio (macOS 14.2 or later).
pub fn supported() -> bool {
    Class::get("CATapDescription").is_some() && sym::<CreateTap>("AudioHardwareCreateProcessTap").is_some()
}

unsafe fn nsstring(s: &str) -> *mut Object {
    let c = CString::new(s).unwrap_or_default();
    msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
}

unsafe fn nsnumber_u32(v: u32) -> *mut Object {
    msg_send![class!(NSNumber), numberWithUnsignedInt: v]
}

unsafe fn nsnumber_bool(v: bool) -> *mut Object {
    msg_send![class!(NSNumber), numberWithBool: v]
}

unsafe fn get<T: Default>(id: ObjectId, selector: &[u8; 4], qualifier: Option<&i32>) -> Option<T> {
    let addr = Address { selector: fourcc(selector), scope: GLOBAL, element: 0 };
    let mut out = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    let (qs, qd) = match qualifier {
        Some(q) => (std::mem::size_of::<i32>() as u32, q as *const i32 as *const c_void),
        None => (0, std::ptr::null()),
    };
    let err = AudioObjectGetPropertyData(id, &addr, qs, qd, &mut size, &mut out as *mut T as *mut c_void);
    (err == 0).then_some(out)
}

/// Default output device's UID (the aggregate's clock).
unsafe fn output_uid() -> Option<String> {
    let dev: ObjectId = get(1, b"dOut", None)?;
    let s: usize = get(dev, b"uid ", None)?; // CFStringRef, +1
    if s == 0 {
        return None;
    }
    let obj = s as *mut Object;
    let p: *const std::os::raw::c_char = msg_send![obj, UTF8String];
    let out = (!p.is_null()).then(|| CStr::from_ptr(p).to_string_lossy().to_string());
    let _: () = msg_send![obj, release];
    out
}

type Sink = Box<dyn FnMut(&[f32]) + Send>;

/// A running capture. Dropping it stops and tears everything down.
pub struct SystemTap {
    tap: ObjectId,
    aggregate: ObjectId,
    proc_id: IoProcId,
    sink: *mut Sink,
}

// The raw pointers are only touched on creation, in the IO proc, and in Drop.
unsafe impl Send for SystemTap {}

extern "C" fn io_proc(
    _dev: ObjectId,
    _now: *const c_void,
    input: *const AudioBufferList,
    _in_time: *const c_void,
    _out: *mut AudioBufferList,
    _out_time: *const c_void,
    client: *mut c_void,
) -> OSStatus {
    if input.is_null() || client.is_null() {
        return 0;
    }
    unsafe {
        let list = &*input;
        let buffers = std::slice::from_raw_parts(list.buffers.as_ptr(), list.count as usize);
        // Mix every channel of every buffer down to mono.
        let mut mono: Vec<f32> = Vec::new();
        let mut channels_total = 0usize;
        for b in buffers {
            if b.data.is_null() || b.channels == 0 {
                continue;
            }
            let ch = b.channels as usize;
            let samples = std::slice::from_raw_parts(b.data as *const f32, b.bytes as usize / 4);
            let frames = samples.len() / ch;
            if mono.is_empty() {
                mono = vec![0.0; frames];
            }
            for (i, frame) in samples.chunks(ch).take(mono.len()).enumerate() {
                mono[i] += frame.iter().sum::<f32>();
            }
            channels_total += ch;
        }
        if mono.is_empty() || channels_total == 0 {
            return 0;
        }
        let k = 1.0 / channels_total as f32;
        mono.iter_mut().for_each(|s| *s *= k);
        let sink = &mut *(client as *mut Sink);
        sink(&mono);
    }
    0
}

impl SystemTap {
    /// Start capturing. Returns the capture and its sample rate; `sink` gets mono f32.
    pub fn start(sink: Sink) -> Result<(SystemTap, u32), String> {
        let create: CreateTap = sym("AudioHardwareCreateProcessTap")
            .ok_or("System audio needs macOS 14.2 or later.")?;
        let destroy: Option<DestroyTap> = sym("AudioHardwareDestroyProcessTap");
        let desc_class = Class::get("CATapDescription").ok_or("System audio needs macOS 14.2 or later.")?;
        unsafe {
            // Leave LocalFlow's own sounds out.
            let pid = std::process::id() as i32;
            let me: ObjectId = get(1, b"id2p", Some(&pid)).unwrap_or(0);
            let exclude: *mut Object = if me != 0 {
                let n = nsnumber_u32(me);
                msg_send![class!(NSArray), arrayWithObject: n]
            } else {
                msg_send![class!(NSArray), array]
            };
            let desc: *mut Object = msg_send![desc_class, alloc];
            let desc: *mut Object = msg_send![desc, initStereoGlobalTapButExcludeProcesses: exclude];
            if desc.is_null() {
                return Err("Couldn't set up system audio capture.".into());
            }
            let _: () = msg_send![desc, setPrivate: true];
            let mut tap: ObjectId = 0;
            let err = create(desc, &mut tap);
            if err != 0 || tap == 0 {
                let _: () = msg_send![desc, release];
                return Err(format!(
                    "macOS didn't allow system audio capture ({err}). Allow LocalFlow under System Settings → Privacy & Security → Screen & System Audio Recording."
                ));
            }
            let uuid: *mut Object = msg_send![desc, UUID];
            let uuid_s: *mut Object = msg_send![uuid, UUIDString];

            let fmt: StreamDescription = get(tap, b"tfmt", None).unwrap_or_default();
            let rate = if fmt.sample_rate > 0.0 { fmt.sample_rate as u32 } else { 48_000 };

            let out_uid = output_uid().unwrap_or_default();
            let agg_uid = format!("com.localflow.systemaudio.{}", uuid::Uuid::new_v4());
            let d: *mut Object = msg_send![class!(NSMutableDictionary), dictionary];
            let set = |k: &str, v: *mut Object| {
                let key = nsstring(k);
                let _: () = msg_send![d, setObject: v forKey: key];
            };
            set("name", nsstring("LocalFlow System Audio"));
            set("uid", nsstring(&agg_uid));
            set("private", nsnumber_bool(true));
            set("stacked", nsnumber_bool(false));
            set("tapautostart", nsnumber_bool(true));
            if !out_uid.is_empty() {
                set("master", nsstring(&out_uid));
                let sub: *mut Object = msg_send![class!(NSMutableDictionary), dictionary];
                let _: () = msg_send![sub, setObject: nsstring(&out_uid) forKey: nsstring("uid")];
                let subs: *mut Object = msg_send![class!(NSArray), arrayWithObject: sub];
                set("subdevices", subs);
            }
            let t: *mut Object = msg_send![class!(NSMutableDictionary), dictionary];
            let _: () = msg_send![t, setObject: uuid_s forKey: nsstring("uid")];
            let _: () = msg_send![t, setObject: nsnumber_bool(true) forKey: nsstring("drift")];
            let taps: *mut Object = msg_send![class!(NSArray), arrayWithObject: t];
            set("taps", taps);

            let mut aggregate: ObjectId = 0;
            let err = AudioHardwareCreateAggregateDevice(d as *const c_void, &mut aggregate);
            let _: () = msg_send![desc, release];
            if err != 0 || aggregate == 0 {
                if let Some(f) = destroy {
                    f(tap);
                }
                return Err(format!("Couldn't open system audio ({err})."));
            }

            let sink: *mut Sink = Box::into_raw(Box::new(sink));
            let mut proc_id: IoProcId = std::ptr::null_mut();
            let err = AudioDeviceCreateIOProcID(aggregate, io_proc, sink as *mut c_void, &mut proc_id);
            if err != 0 {
                AudioHardwareDestroyAggregateDevice(aggregate);
                if let Some(f) = destroy {
                    f(tap);
                }
                drop(Box::from_raw(sink));
                return Err(format!("Couldn't read system audio ({err})."));
            }
            let me = SystemTap { tap, aggregate, proc_id, sink };
            let err = AudioDeviceStart(aggregate, proc_id);
            if err != 0 {
                return Err(format!("Couldn't start system audio ({err})."));
            }
            Ok((me, rate))
        }
    }
}

impl Drop for SystemTap {
    fn drop(&mut self) {
        unsafe {
            AudioDeviceStop(self.aggregate, self.proc_id);
            AudioDeviceDestroyIOProcID(self.aggregate, self.proc_id);
            AudioHardwareDestroyAggregateDevice(self.aggregate);
            if let Some(f) = sym::<DestroyTap>("AudioHardwareDestroyProcessTap") {
                f(self.tap);
            }
            drop(Box::from_raw(self.sink));
        }
    }
}
