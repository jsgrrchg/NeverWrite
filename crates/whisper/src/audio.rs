use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

use crate::WhisperError;

const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Decodes any supported audio file to mono f32 samples at 16 kHz.
pub fn decode_to_mono_16k(path: &Path) -> Result<Vec<f32>, WhisperError> {
    let file = std::fs::File::open(path).map_err(WhisperError::Io)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| WhisperError::AudioDecode(e.to_string()))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| WhisperError::AudioDecode("no audio track found".into()))?;

    let source_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| WhisperError::AudioDecode("unknown sample rate".into()))?;
    let track_id = track.id;

    let mut decoder = get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| WhisperError::AudioDecode(e.to_string()))?;

    let mut mono_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(WhisperError::AudioDecode(e.to_string())),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(WhisperError::AudioDecode(e.to_string())),
        };

        let spec = *decoded.spec();
        let channels = spec.channels.count();
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);

        let raw = buf.samples();
        for frame in raw.chunks(channels) {
            let mono: f32 = frame.iter().sum::<f32>() / channels as f32;
            mono_samples.push(mono);
        }
    }

    if source_rate == TARGET_SAMPLE_RATE {
        return Ok(mono_samples);
    }

    resample(&mono_samples, source_rate, TARGET_SAMPLE_RATE)
}

fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>, WhisperError> {
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };

    let ratio = to_rate as f64 / from_rate as f64;
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let chunk_size = 1024;
    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, chunk_size, 1)
        .map_err(|e| WhisperError::AudioDecode(format!("resampler init: {e}")))?;

    let mut output = Vec::with_capacity((samples.len() as f64 * ratio) as usize + chunk_size);

    for chunk in samples.chunks(chunk_size) {
        let input = if chunk.len() < chunk_size {
            let mut padded = chunk.to_vec();
            padded.resize(chunk_size, 0.0);
            padded
        } else {
            chunk.to_vec()
        };

        let result = resampler
            .process(&[input], None)
            .map_err(|e| WhisperError::AudioDecode(format!("resample: {e}")))?;

        if let Some(channel) = result.first() {
            output.extend_from_slice(channel);
        }
    }

    // Trim padding artifacts from the last chunk
    let expected_len = (samples.len() as f64 * ratio) as usize;
    output.truncate(expected_len);

    Ok(output)
}
