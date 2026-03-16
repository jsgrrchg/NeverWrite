use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct WhisperModel {
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
    pub checksum_sha256: &'static str,
    pub size_bytes: u64,
    pub recommended: bool,
}

pub const MODELS: &[WhisperModel] = &[
    WhisperModel {
        id: "tiny",
        label: "Tiny (~75 MB)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        checksum_sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        size_bytes: 77_691_713,
        recommended: false,
    },
    WhisperModel {
        id: "base",
        label: "Base (~142 MB)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        checksum_sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        size_bytes: 147_951_465,
        recommended: true,
    },
    WhisperModel {
        id: "small",
        label: "Small (~466 MB)",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        checksum_sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        size_bytes: 487_601_967,
        recommended: false,
    },
];

pub fn find_model(id: &str) -> Option<&'static WhisperModel> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn model_filename(model: &WhisperModel) -> String {
    format!("ggml-{}.bin", model.id)
}
