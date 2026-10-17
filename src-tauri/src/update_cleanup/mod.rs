//! Cleanup policy copied from the independently verified standalone prototype.
//! Native adapters must provide independent evidence, exclusive durable storage,
//! and exact verified-handle deletion. Receipt fields never authorize cleanup.
pub(crate) mod codec;
#[cfg(test)]
mod codec_tests;
pub(crate) mod engine;
#[cfg(test)]
mod lifecycle_tests;
