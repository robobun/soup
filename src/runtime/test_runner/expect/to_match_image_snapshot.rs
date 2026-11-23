use bun_core::strings;
use bun_jsc::bindgen::{JsLocal, JsScope};
use bun_jsc::{JSValue, JsResult, bun_string_jsc};
use bun_paths::Path;
use bun_resolver::fs::FileSystem;
use bun_sys_jsc::ErrorJsc as _;

use super::Expect;
use super::matcher::{Matcher, This, Verdict, fail, params};
use super::snapshots::{begin_snapshot, fail_outside_of_a_test};
use crate::test_runner::image_snapshot::{self, Files, Outcome, Picture};
use crate::test_runner::jest::Jest;
use crate::webcore::{Blob, BlobExt as _};

/// `customSnapshotIdentifier`
enum Identifier {
    Default,
    Named(Vec<u8>),
    Function(JSValue),
}

/// The options of jest-image-snapshot that Bun has.
struct Request {
    comparison: image_snapshot::Options,
    identifier: Identifier,
    snapshots_dir: Option<Vec<u8>>,
    diff_dir: Option<Vec<u8>>,
    received_dir: Option<Vec<u8>>,
    received_postfix: Vec<u8>,
}

/// A part of a path.
fn text(m: &Matcher<'_>, name: &str, value: JSValue) -> JsResult<Vec<u8>> {
    if value.is_string() {
        let text = value.to_js_string_view(m.global)?.to_utf8().to_vec();
        if !strings::contains_char(&text, 0) {
            return Ok(text);
        }
    }
    Err(m.fail_unsigned(&format!("Expected {name} to be a string without null bytes")))
}

fn number(m: &Matcher<'_>, name: &str, value: JSValue, max: f64) -> JsResult<f64> {
    if value.is_number() && (0.0..=max).contains(&value.as_number()) {
        return Ok(value.as_number());
    }
    Err(m.fail_unsigned(&if max.is_infinite() {
        format!("Expected {name} to be a number that is not negative")
    } else {
        format!("Expected {name} to be a number from 0 to {max}")
    }))
}

/// Which of the two `words` the option is.
fn choice(m: &Matcher<'_>, name: &str, value: JSValue, words: [&'static str; 2]) -> JsResult<bool> {
    if value.is_string() {
        let chosen = value.to_js_string_view(m.global)?;
        if let Some(index) = words.iter().position(|word| chosen.eq_ascii(word.as_bytes())) {
            return Ok(index == 1);
        }
    }
    Err(m.fail_unsigned(&format!("Expected {name} to be \"{}\" or \"{}\"", words[0], words[1])))
}

impl Request {
    #[optimize(size)]
    fn from_js(m: &Matcher<'_>, options: JSValue) -> JsResult<Request> {
        let mut request = Request {
            comparison: image_snapshot::Options::default(),
            identifier: Identifier::Default,
            snapshots_dir: None,
            diff_dir: None,
            received_dir: None,
            received_postfix: b"-received".to_vec(),
        };
        if options.is_undefined() {
            return Ok(request);
        }
        if !options.is_object() {
            return Err(m.fail_unsigned("Expected first argument to be an object"));
        }
        let global = m.global;
        let get = |name: &str| Ok::<_, bun_jsc::JsError>(options.get(global, name)?.filter(|value| !value.is_undefined()));
        let comparison = &mut request.comparison;

        if let Some(config) = get("customDiffConfig")? {
            if !config.is_object() {
                return Err(m.fail_unsigned("Expected customDiffConfig to be an object"));
            }
            if let Some(threshold) = config.get(global, "threshold")?.filter(|value| !value.is_undefined()) {
                comparison.threshold = number(m, "customDiffConfig.threshold", threshold, 1.0)?;
            }
            if let Some(include_aa) = config.get(global, "includeAA")? {
                comparison.include_aa = include_aa.to_boolean();
            }
        }
        if let Some(threshold) = get("failureThreshold")? {
            comparison.failure_threshold = number(m, "failureThreshold", threshold, f64::INFINITY)?;
        }
        if let Some(kind) = get("failureThresholdType")? {
            comparison.failure_threshold_is_ratio = choice(m, "failureThresholdType", kind, ["pixel", "percent"])?;
        }
        if let Some(direction) = get("diffDirection")? {
            comparison.diff_is_vertical = choice(m, "diffDirection", direction, ["horizontal", "vertical"])?;
        }
        // The two options that change what a difference is, and that Bun does not have.
        if let Some(method) = get("comparisonMethod")?
            && choice(m, "comparisonMethod", method, ["pixelmatch", "ssim"])?
        {
            return Err(m.fail_unsigned("comparisonMethod \"ssim\" is not supported: Bun compares with pixelmatch"));
        }
        if let Some(blur) = get("blur")?
            && number(m, "blur", blur, f64::INFINITY)? > 0.0
        {
            return Err(m.fail_unsigned("blur is not supported"));
        }
        comparison.allow_size_mismatch = get("allowSizeMismatch")?.is_some_and(JSValue::to_boolean);
        comparison.update_passed_snapshot = get("updatePassedSnapshot")?.is_some_and(JSValue::to_boolean);
        comparison.only_diff = get("onlyDiff")?.is_some_and(JSValue::to_boolean);
        comparison.store_received = get("storeReceivedOnFailure")?.is_some_and(JSValue::to_boolean);

        // jest-image-snapshot reads these two with `||`, so an empty string is as good as none.
        if let Some(identifier) = get("customSnapshotIdentifier")? {
            request.identifier = if identifier.is_callable() {
                Identifier::Function(identifier)
            } else {
                match text(m, "customSnapshotIdentifier", identifier)? {
                    name if name.is_empty() => Identifier::Default,
                    name => Identifier::Named(name),
                }
            };
        }
        if let Some(dir) = get("customSnapshotsDir")? {
            request.snapshots_dir = Some(text(m, "customSnapshotsDir", dir)?).filter(|dir| !dir.is_empty());
        }
        if let Some(dir) = get("customDiffDir")? {
            request.diff_dir = Some(text(m, "customDiffDir", dir)?);
        }
        if let Some(dir) = get("customReceivedDir")? {
            request.received_dir = Some(text(m, "customReceivedDir", dir)?);
        }
        if let Some(postfix) = get("customReceivedPostfix")? {
            request.received_postfix = text(m, "customReceivedPostfix", postfix)?;
        }
        Ok(request)
    }
}

/// A copy of the file of the image: `customSnapshotIdentifier` runs script before the file is compared.
fn encoded_image(m: &Matcher<'_>, received: JSValue) -> JsResult<Vec<u8>> {
    if let Some(buffer) = received.as_array_buffer(m.global) {
        return Ok(buffer.byte_slice().to_vec());
    }
    if let Some(blob) = received.as_class_ref::<Blob>() {
        return match blob.in_memory_view() {
            Some(bytes) => Ok(bytes.to_vec()),
            None => fail!(
                m,
                "<b>Matcher error<r>: <red>received<r> value is a file that has not been read. Pass <green>await file.bytes()<r>\n"
            ),
        };
    }
    fail!(
        m,
        "<b>Matcher error<r>: <red>received<r> value must be an image in a Buffer, a typed array, an ArrayBuffer or a Blob\n\nReceived: <red>{}<r>\n",
        m.show(received)
    )
}

impl Expect {
    #[optimize(size)]
    pub(crate) fn to_match_image_snapshot(&self, this: This<'_>, cx: &mut JsScope<'_>, options: JsLocal<'_>) -> Verdict {
        let m = begin_snapshot(this, cx, "toMatchImageSnapshot", params!("<green>options<r>"))?;
        let global = m.global;
        let (Some(_), Some(runner)) = (self.bun_test(), Jest::runner()) else {
            return fail_outside_of_a_test(&m, true);
        };
        let request = Request::from_js(&m, options.to_js())?;
        let encoded = encoded_image(&m, m.received()?)?;
        let Ok(picture) = Picture::decode(&encoded) else {
            return fail!(
                m,
                "<b>Matcher error<r>: <red>received<r> value is not an image that Bun can decode. It has {} bytes\n",
                encoded.len()
            );
        };

        let (test_file, test_name, count) = match runner.with_snapshots(|snapshots| snapshots.count_image(self)) {
            Ok(counted) => counted,
            Err(err) => return Err(self.throw_snapshot_error(global, &err, b"")),
        };
        let default_identifier = image_snapshot::default_identifier(test_file.path, &test_name, count);
        let identifier = match request.identifier {
            Identifier::Default => [&default_identifier[..], b"-snap"].concat(),
            Identifier::Named(name) => name,
            Identifier::Function(function) => {
                let test = JSValue::create_empty_object(global, 4);
                test.put(global, b"testPath", bun_string_jsc::create_utf8_for_js(global, test_file.path)?);
                test.put(global, b"currentTestName", bun_string_jsc::create_utf8_for_js(global, &test_name)?);
                test.put(global, b"counter", JSValue::js_number_from_uint64(count as u64));
                test.put(global, b"defaultIdentifier", bun_string_jsc::create_utf8_for_js(global, &default_identifier)?);
                match function.call(global, JSValue::UNDEFINED, &[test])? {
                    // jest-image-snapshot: `customSnapshotIdentifier(..) || defaultIdentifier`, which has no `-snap`.
                    returned if !returned.to_boolean() => default_identifier,
                    returned => text(&m, "what customSnapshotIdentifier returns", returned)?,
                }
            }
        };

        // jest-image-snapshot gives these to `path.join()`, so one that is relative is in the working directory.
        let in_cwd = |dir: &[u8]| Path::resolve(&[FileSystem::instance().top_level_dir(), dir]);
        let file_in = |dir: &Path, suffix: &[u8]| {
            let mut path = Path::join(&[dir.as_bytes(), &identifier]);
            path.extend_from_slice(suffix);
            path.extend_from_slice(b".png");
            path
        };
        let snapshots_dir = match &request.snapshots_dir {
            Some(dir) => in_cwd(dir),
            None => Path::join(&[bun_paths::dirname_or_root(test_file.path), b"__image_snapshots__"]),
        };
        let below_snapshots = |custom: &Option<Vec<u8>>, name: &[u8]| match custom {
            Some(dir) => in_cwd(dir),
            None => Path::join(&[snapshots_dir.as_bytes(), name]),
        };
        let snapshot_path = file_in(&snapshots_dir, b"");
        let diff_path = file_in(&below_snapshots(&request.diff_dir, b"__diff_output__"), b"-diff");
        let received_path = file_in(&below_snapshots(&request.received_dir, b"__received_output__"), &request.received_postfix);
        let files =
            Files { snapshot: snapshot_path.as_bytes(), diff: diff_path.as_bytes(), received: received_path.as_bytes() };

        let update = runner.with_snapshots(|snapshots| snapshots.update_snapshots);
        let outcome = image_snapshot::match_or_write(&encoded, &picture, &files, &request.comparison, update);
        runner.with_snapshots(|snapshots| match outcome {
            Outcome::Passed => snapshots.passed += 1,
            Outcome::Written | Outcome::Updated => snapshots.added += 1,
            Outcome::Mismatch(_) => snapshots.failed += 1,
            _ => {}
        });
        let shown = |path: &[u8]| bstr::BStr::new(path).to_string();
        match outcome {
            Outcome::Passed | Outcome::Written | Outcome::Updated => m.pass(),
            Outcome::Mismatch(difference) => {
                let ((snapshot_width, snapshot_height), (width, height)) = (difference.snapshot_size, difference.received_size);
                let what = if difference.is_of_size() && !request.comparison.allow_size_mismatch {
                    format!(
                        "Expected image to be the same size as the snapshot ({snapshot_width}x{snapshot_height}), but was different ({width}x{height})."
                    )
                } else {
                    format!(
                        "Expected image to match or be a close match to snapshot but was {}% different from snapshot ({} differing pixels).",
                        difference.ratio * 100.0,
                        difference.pixels
                    )
                };
                fail!(m, "{}\n<b>See diff for details:<r> <red>{}<r>\n", what, shown(files.diff))
            }
            Outcome::NotAllowedInCI => Err(global.throw(format_args!(
                "Snapshot creation is disabled in CI environments unless --update-snapshots is used\nTo override, set the environment variable CI=false.\n\nSnapshot file: \"{}\"",
                shown(files.snapshot),
            ))),
            Outcome::SnapshotUnreadable(err) => Err(global.throw(format_args!(
                "toMatchImageSnapshot() can't decode the snapshot ({err}). Run with --update-snapshots to write it again: {}",
                shown(files.snapshot),
            ))),
            Outcome::EncodeFailed(err) => {
                Err(global.throw(format_args!("toMatchImageSnapshot() can't encode a PNG ({err}) for {}", shown(files.snapshot))))
            }
            Outcome::Failed(err) => Err(global.throw_value(err.to_js(global)?)),
        }
    }
}
