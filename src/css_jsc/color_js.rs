use bun_alloc::Arena;
use bun_ast::Log;
use bun_core::String as BunString;
use bun_core::output::{ColorDepth, Source as OutputSource};
use bun_css::values::color::RGBA;
use bun_jsc::bindgen::{self, JsHeap, JsScope, to_js};
use bun_jsc::{JSGlobalObject, JSType, JSValue};

use crate::JsResult;
use crate::generated_bindgen::color_js::{
    ColorChannels, ColorInput, ColorOutput, ColorOutputChannels, OutputColorFormat,
};

/// CSS spec says to clamp values to their valid range so we'll respect that here
fn clamp_to_u8(value: f64) -> u8 {
    value as u8
}

fn color_int_from_js(
    global: &JSGlobalObject,
    input: JSValue,
    property: &'static str,
) -> JsResult<u8> {
    if input.is_empty() || input.is_undefined() || !input.is_number() {
        return Err(global.throw_invalid_argument_type("color", property, "integer"));
    }
    Ok(clamp_to_u8(input.as_number()))
}

/// `list` is an array, a typed array or an `ArrayBuffer`.
fn rgba_from_list(global: &JSGlobalObject, list: JSValue) -> JsResult<RGBA> {
    let length = list.get_length(global)?;
    if !matches!(length, 3 | 4) {
        return Err(global.throw(format_args!("Expected array length 3 or 4")));
    }
    Ok(RGBA {
        red: color_int_from_js(global, list.get_index(global, 0)?, "[0]")?,
        green: color_int_from_js(global, list.get_index(global, 1)?, "[1]")?,
        blue: color_int_from_js(global, list.get_index(global, 2)?, "[2]")?,
        alpha: if length == 4 {
            color_int_from_js(global, list.get_index(global, 3)?, "[3]")?
        } else {
            255
        },
    })
}

fn rgba_from_channels(channels: &ColorChannels) -> RGBA {
    RGBA {
        red: clamp_to_u8(channels.r),
        green: clamp_to_u8(channels.g),
        blue: clamp_to_u8(channels.b),
        alpha: channels.a.map_or(255, |a| clamp_to_u8(a * 255.0)),
    }
}

/// A missing color component (CSS Color 4's `none`, or the hue of an achromatic
/// color) is stored as NaN, and behaves as zero outside of interpolation. Printing
/// it as `NaN` would produce a string no CSS parser accepts.
fn zero_if_none(component: f32) -> f32 {
    if component.is_nan() { 0.0 } else { component }
}

fn channel_list<'a, const N: usize>(
    heap: &JsHeap<'a>,
    channels: [u8; N],
) -> bindgen::Result<'a, Option<ColorOutput<'a>>> {
    Ok(Some(ColorOutput::List(
        heap.create_array(channels, to_js::u8)?,
    )))
}

pub(crate) fn color<'a>(
    cx: &mut JsScope<'a>,
    input: ColorInput<'a>,
    output_format: OutputColorFormat,
) -> bindgen::Result<'a, Option<ColorOutput<'a>>> {
    use bun_ast::symbol::Map as SymbolMap;
    use bun_css as css;
    use bun_css::CssColor;
    use bun_css::values::color::{Colorspace as _, HSL, LAB, SRGB};

    let log = Log::init();

    let parsed_color: css::CssColorParseResult = match input {
        ColorInput::Missing => {
            return Err(cx
                .global()
                .throw_invalid_argument_type("color", "input", "string, number, or object")
                .into());
        }
        ColorInput::Number(number) => {
            // The color is the low 32 bits, LSB-first: blue, green, red,
            // alpha (one byte each).
            let int: u32 = (number as i64) as u32;
            let blue = (int & 0xff) as u8;
            let green = ((int >> 8) & 0xff) as u8;
            let red = ((int >> 16) & 0xff) as u8;
            // A 24-bit 0xRRGGBB number has no alpha byte and means an opaque
            // color; only values wider than 24 bits carry alpha in the top byte.
            let alpha = if int > 0x00ff_ffff {
                (int >> 24) as u8
            } else {
                255
            };

            Ok(CssColor::Rgba(RGBA {
                alpha,
                red,
                green,
                blue,
            }))
        }
        ColorInput::List(list) => Ok(CssColor::Rgba(rgba_from_list(cx.global(), list.to_js())?)),
        ColorInput::Buffer(buffer) => {
            let (global, buffer) = (cx.global(), buffer.to_js());
            Ok(CssColor::Rgba(if buffer.js_type() == JSType::DataView {
                rgba_from_channels(&ColorChannels::from_js(global, buffer)?)
            } else {
                rgba_from_list(global, buffer)?
            }))
        }
        ColorInput::Channels(channels) => Ok(CssColor::Rgba(rgba_from_channels(&channels))),
        ColorInput::Text(text) => {
            // MimallocArena::new() calls mi_heap_new(), so defer creation to the
            // paths that actually allocate.
            let arena = Arena::new();
            let mut parser_input = css::ParserInput::new(text, &arena);
            let mut parser = css::Parser::new(
                &mut parser_input,
                None,
                css::css_parser::ParserOpts::CLIP_COLORS,
                None,
            );
            CssColor::parse(&mut parser)
        }
    };
    let heap = &cx.heap;

    match parsed_color {
        Err(err) => {
            if log.msgs.is_empty() {
                return Ok(None);
            }

            let kind_name = match err.basic().kind {
                css::BasicParseErrorKind::unexpected_token(_) => "unexpected_token",
                css::BasicParseErrorKind::end_of_input => "end_of_input",
                css::BasicParseErrorKind::at_rule_invalid(_) => "at_rule_invalid",
                css::BasicParseErrorKind::at_rule_body_invalid => "at_rule_body_invalid",
                css::BasicParseErrorKind::qualified_rule_invalid => "qualified_rule_invalid",
            };
            return Err(heap.error(format_args!("color() failed to parse {}", kind_name)));
        }
        Ok(result) => {
            let format: OutputColorFormat = if output_format == OutputColorFormat::Ansi {
                match OutputSource::color_depth() {
                    // No color terminal, therefore return an empty string
                    ColorDepth::None => return Ok(Some(ColorOutput::Text(BunString::EMPTY))),
                    ColorDepth::C16 => OutputColorFormat::Ansi16,
                    ColorDepth::C16m => OutputColorFormat::Ansi16m,
                    ColorDepth::C256 => OutputColorFormat::Ansi256,
                }
            } else {
                output_format
            };

            'formatted: {
                let str: BunString = 'color: {
                    match format {
                        // resolved above.
                        OutputColorFormat::Ansi => unreachable!(),

                        // Use the CSS printer.
                        OutputColorFormat::Css => break 'formatted,

                        tag @ (OutputColorFormat::Number
                        | OutputColorFormat::Rgb
                        | OutputColorFormat::Rgba
                        | OutputColorFormat::Hex
                        | OutputColorFormat::HexUpper
                        | OutputColorFormat::Ansi16
                        | OutputColorFormat::Ansi16m
                        | OutputColorFormat::Ansi256
                        | OutputColorFormat::RgbaObject
                        | OutputColorFormat::RgbObject
                        | OutputColorFormat::RgbaArray
                        | OutputColorFormat::RgbArray) => {
                            // `currentColor`, a system color and `light-dark()` have no channels.
                            let Some(srgba) = SRGB::try_from_css_color(&result) else {
                                return Ok(None);
                            };
                            let rgba = srgba.into_rgba();
                            match tag {
                                OutputColorFormat::RgbaObject => {
                                    return Ok(Some(ColorOutput::Channels(ColorOutputChannels {
                                        r: rgba.red,
                                        g: rgba.green,
                                        b: rgba.blue,
                                        a: Some(rgba.alpha_f32() as f64),
                                    })));
                                }
                                OutputColorFormat::RgbObject => {
                                    return Ok(Some(ColorOutput::Channels(ColorOutputChannels {
                                        r: rgba.red,
                                        g: rgba.green,
                                        b: rgba.blue,
                                        a: None,
                                    })));
                                }
                                OutputColorFormat::RgbArray => {
                                    return channel_list(heap, [rgba.red, rgba.green, rgba.blue]);
                                }
                                OutputColorFormat::RgbaArray => {
                                    return channel_list(
                                        heap,
                                        [rgba.red, rgba.green, rgba.blue, rgba.alpha],
                                    );
                                }
                                OutputColorFormat::Number => {
                                    let mut int: u32 = 0;
                                    int |= (rgba.red as u32) << 16;
                                    int |= (rgba.green as u32) << 8;
                                    int |= rgba.blue as u32;
                                    return Ok(Some(ColorOutput::Number(int)));
                                }
                                OutputColorFormat::Hex => {
                                    break 'color BunString::create_format(format_args!(
                                        "#{:02x}{:02x}{:02x}",
                                        rgba.red, rgba.green, rgba.blue
                                    ));
                                }
                                OutputColorFormat::HexUpper => {
                                    break 'color BunString::create_format(format_args!(
                                        "#{:02X}{:02X}{:02X}",
                                        rgba.red, rgba.green, rgba.blue
                                    ));
                                }
                                OutputColorFormat::Rgb => {
                                    break 'color BunString::create_format(format_args!(
                                        "rgb({}, {}, {})",
                                        rgba.red, rgba.green, rgba.blue
                                    ));
                                }
                                OutputColorFormat::Rgba => {
                                    break 'color BunString::create_format(format_args!(
                                        "rgba({}, {}, {}, {})",
                                        rgba.red,
                                        rgba.green,
                                        rgba.blue,
                                        rgba.alpha_f32()
                                    ));
                                }
                                OutputColorFormat::Ansi16
                                | OutputColorFormat::Ansi16m
                                | OutputColorFormat::Ansi256 => {
                                    let depth = match tag {
                                        OutputColorFormat::Ansi16 => ColorDepth::C16,
                                        OutputColorFormat::Ansi256 => ColorDepth::C256,
                                        _ => ColorDepth::C16m,
                                    };
                                    let mut buf: Vec<u8> = Vec::with_capacity(24);
                                    buf.extend_from_slice(b"\x1b[");
                                    depth.write_sgr_color(
                                        &mut buf, false, rgba.red, rgba.green, rgba.blue,
                                    );
                                    buf.push(b'm');
                                    break 'color BunString::clone_latin1(&buf);
                                }
                                _ => unreachable!(),
                            }
                        }

                        OutputColorFormat::Hsl => {
                            let Some(hsl) = HSL::try_from_css_color(&result) else {
                                return Ok(None);
                            };

                            // Saturation and lightness are stored as 0..1 but hsl()
                            // takes percentages. A missing component (an achromatic
                            // hue, or `none`) is a zero value in a concrete color.
                            break 'color BunString::create_format(format_args!(
                                "hsl({}, {}%, {}%)",
                                zero_if_none(hsl.h),
                                zero_if_none(hsl.s) * 100.0,
                                zero_if_none(hsl.l) * 100.0
                            ));
                        }
                        OutputColorFormat::Lab => {
                            let Some(lab) = LAB::try_from_css_color(&result) else {
                                return Ok(None);
                            };

                            // lab() is space-separated and takes lightness as a
                            // percentage, matching what the CSS printer emits.
                            break 'color BunString::create_format(format_args!(
                                "lab({}% {} {})",
                                zero_if_none(lab.l) * 100.0,
                                zero_if_none(lab.a),
                                zero_if_none(lab.b)
                            ));
                        }
                    }
                };

                return Ok(Some(ColorOutput::Text(str)));
            }

            // Fallback to CSS string output
            let arena = Arena::new();
            let mut dest: Vec<u8> = Vec::new();

            let symbols = SymbolMap::init_list(Default::default());
            let mut printer = css::Printer::new(
                &arena,
                bun_alloc::ArenaVec::<u8>::new_in(&arena),
                &mut dest,
                &css::PrinterOptions::default(),
                None,
                None,
                &symbols,
            );

            if let Err(err) = result.to_css(&mut printer) {
                return Err(heap.error(format_args!("color() internal error: {}", err.name())));
            }
            drop(printer);

            return Ok(Some(ColorOutput::Css(dest)));
        }
    }
}
