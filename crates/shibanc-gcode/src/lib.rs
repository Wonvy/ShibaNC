pub mod infer;
pub mod parser;
pub mod samples;
pub mod types;

pub use parser::{parse_bytes, parse_file, GcodeError};
pub use samples::{generate_mechanical_nc_sample, generate_relief_tap_sample};
pub use types::{GpuSegment, ParsedProgram, StockSpec, ToolKind, ToolSpec, ToolpathStats};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_relief_tap_and_mechanical_nc() {
        let tap = generate_relief_tap_sample();
        let p_tap = parse_bytes(tap.as_bytes(), "lotus.tap", "tap").expect("tap parse");
        assert!(p_tap.segments.len() > 20_000);
        assert_eq!(p_tap.tool.kind, ToolKind::TaperedBallNose);

        let nc = generate_mechanical_nc_sample();
        let p_nc = parse_bytes(nc.as_bytes(), "bracket.nc", "nc").expect("nc parse");
        assert!(p_nc.segments.len() > 500);
        assert_eq!(p_nc.tool.kind, ToolKind::FlatEndMill);
    }
}
