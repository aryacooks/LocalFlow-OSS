/// thermal.rs — how hot the Mac is, for the Dashboard's diagnostics panel.
///
/// `cpu_temp_c` reads the Apple Silicon die sensors through IOKit's HID event system
/// (the same sensors menu-bar temperature apps use; no root needed). It returns the
/// hottest CPU die reading in °C, or None when the sensors can't be read (Intel Macs,
/// Windows, a future macOS that hides them).
///
/// `thermal_state` is macOS's own summary (Normal / Warm / Hot / Critical) and always
/// works on a Mac, so the panel has something to show even without a number.
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Sensors are polled at most this often; the Dashboard asks every 1.5 s.
const REFRESH: Duration = Duration::from_secs(4);

static CACHE: Mutex<Option<(Instant, Option<f64>)>> = Mutex::new(None);

pub fn cpu_temp_c() -> Option<f64> {
    let mut c = CACHE.lock().ok()?;
    if let Some((at, v)) = *c {
        if at.elapsed() < REFRESH {
            return v;
        }
    }
    let v = read_sensors();
    *c = Some((Instant::now(), v));
    v
}

#[cfg(target_os = "macos")]
fn read_sensors() -> Option<f64> {
    use core_foundation::base::{CFRelease, CFType, CFTypeRef, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    type Client = *mut c_void;
    type Service = *mut c_void;
    type Event = *mut c_void;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDEventSystemClientCreate(alloc: *const c_void) -> Client;
        fn IOHIDEventSystemClientSetMatching(client: Client, matching: *const c_void) -> i32;
        fn IOHIDEventSystemClientCopyServices(client: Client) -> *const c_void; // CFArrayRef
        fn IOHIDServiceClientCopyProperty(service: Service, key: CFStringRef) -> CFTypeRef;
        fn IOHIDServiceClientCopyEvent(service: Service, kind: i64, a: i32, b: i64) -> Event;
        fn IOHIDEventGetFloatValue(event: Event, field: i32) -> f64;
    }
    extern "C" {
        fn CFArrayGetCount(arr: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(arr: *const c_void, idx: isize) -> *const c_void;
    }
    const TEMPERATURE: i64 = 15; // kIOHIDEventTypeTemperature
    const FIELD: i32 = (15 << 16) as i32;

    unsafe {
        let client = IOHIDEventSystemClientCreate(std::ptr::null());
        if client.is_null() {
            return None;
        }
        // Apple's vendor page 0xff00, usage 5 = temperature sensors.
        let matching = CFDictionary::from_CFType_pairs(&[
            (CFString::new("PrimaryUsagePage").as_CFType(), CFNumber::from(0xff00i32).as_CFType()),
            (CFString::new("PrimaryUsage").as_CFType(), CFNumber::from(5i32).as_CFType()),
        ]);
        IOHIDEventSystemClientSetMatching(client, matching.as_concrete_TypeRef() as *const c_void);
        let services = IOHIDEventSystemClientCopyServices(client);
        if services.is_null() {
            CFRelease(client as CFTypeRef);
            return None;
        }
        let product_key = CFString::new("Product");
        let (mut cpu_max, mut any_max): (Option<f64>, Option<f64>) = (None, None);
        for i in 0..CFArrayGetCount(services) {
            let svc = CFArrayGetValueAtIndex(services, i) as Service;
            if svc.is_null() {
                continue;
            }
            let name = {
                let p = IOHIDServiceClientCopyProperty(svc, product_key.as_concrete_TypeRef());
                if p.is_null() {
                    String::new()
                } else {
                    let t = CFType::wrap_under_create_rule(p);
                    t.downcast::<CFString>().map(|s| s.to_string()).unwrap_or_default()
                }
            };
            let ev = IOHIDServiceClientCopyEvent(svc, TEMPERATURE, 0, 0);
            if ev.is_null() {
                continue;
            }
            let t = IOHIDEventGetFloatValue(ev, FIELD);
            CFRelease(ev as CFTypeRef);
            if !(5.0..=125.0).contains(&t) {
                continue; // unplugged / placeholder sensors report 0 or junk
            }
            any_max = Some(any_max.map_or(t, |m: f64| m.max(t)));
            // CPU die sensors: "PMU tdie…" (M1/M2) and "pACC/eACC MTR Temp Sensor…" (M3+).
            if name.contains("tdie") || name.contains("ACC MTR") || name.contains("CPU") {
                cpu_max = Some(cpu_max.map_or(t, |m: f64| m.max(t)));
            }
        }
        CFRelease(services as CFTypeRef);
        CFRelease(client as CFTypeRef);
        cpu_max.or(any_max).map(|t| (t * 10.0).round() / 10.0)
    }
}

#[cfg(not(target_os = "macos"))]
fn read_sensors() -> Option<f64> {
    None
}

/// macOS's thermal pressure: "Normal", "Warm", "Hot" or "Critical". None off macOS.
pub fn thermal_state() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};
        let info: *mut Object = msg_send![class!(NSProcessInfo), processInfo];
        if info.is_null() {
            return None;
        }
        let s: i64 = msg_send![info, thermalState];
        return Some(match s {
            0 => "Normal",
            1 => "Warm",
            2 => "Hot",
            _ => "Critical",
        });
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn reads_a_plausible_temperature() {
        let t = super::cpu_temp_c();
        eprintln!("cpu temp: {:?}, state: {:?}", t, super::thermal_state());
        if let Some(t) = t {
            assert!((5.0..=125.0).contains(&t));
        }
        assert!(super::thermal_state().is_some());
    }
}
