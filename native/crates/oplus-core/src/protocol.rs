//! KeyLinker framing adapted from x20ctl, revision fce9627e (GPL-3.0+).
use crate::Result;
use serde::{Deserialize, Serialize};

pub const SERVICE: &str = "d7f010e0-660d-46e9-96c3-19c4148bdab5";
pub const WRITE: &str = "d7f010e1-660d-46e9-96c3-19c4148bdab5";
pub const NOTIFY: &str = "d7f010e2-660d-46e9-96c3-19c4148bdab5";
const SEND: [u8; 15] = [
    51, 99, 157, 121, 242, 219, 162, 26, 170, 33, 139, 232, 116, 211, 88,
];
const SERIAL: [u8; 40] = [
    161, 82, 213, 163, 245, 137, 246, 143, 240, 157, 72, 147, 234, 52, 49, 186, 195, 77, 198, 235,
    73, 96, 216, 163, 218, 42, 83, 141, 244, 97, 24, 191, 174, 215, 111, 81, 228, 160, 217, 146,
];

pub fn crc8(data: &[u8]) -> u8 {
    let mut crc = 0;
    for &byte in data {
        crc ^= byte;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xeb
            } else {
                crc >> 1
            };
        }
    }
    crc
}

fn size(data: &[u8]) -> Result<()> {
    if !(5..=20).contains(&data.len()) {
        return Err("KeyLinker 帧必须为 5–20 字节".into());
    }
    Ok(())
}

pub fn scramble(data: &[u8]) -> Result<Vec<u8>> {
    size(data)?;
    let (s, n) = (data[2], data[3]);
    let mut out = data.to_vec();
    out[0] ^= s.wrapping_add(n).wrapping_sub(154);
    out[1] ^= s.wrapping_add(n).wrapping_add(155);
    out[2] = s.wrapping_sub(173) ^ n;
    out[3] = n.wrapping_add(191) ^ 219;
    for i in 4..data.len() - 1 {
        out[i] ^= s.wrapping_add(n).wrapping_sub(SEND[i - 4]);
    }
    let offset = if out[3] & 2 != 0 { 20 } else { 0 };
    for (i, b) in out.iter_mut().enumerate() {
        *b ^= SERIAL[offset + i];
    }
    Ok(out)
}

pub fn unscramble(data: &[u8]) -> Result<Vec<u8>> {
    size(data)?;
    let offset = if (data[3] ^ SERIAL[3]) & 2 != 0 {
        20
    } else {
        0
    };
    let mut out: Vec<u8> = data
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ SERIAL[offset + i])
        .collect();
    let n = (out[3] ^ 219).wrapping_sub(191);
    let s = (out[2] ^ n).wrapping_add(173);
    out[0] ^= s.wrapping_add(n).wrapping_sub(154);
    out[1] ^= s.wrapping_add(n).wrapping_add(155);
    out[2] = s;
    out[3] = n;
    for i in 4..data.len() - 1 {
        out[i] ^= s.wrapping_add(n).wrapping_sub(SEND[i - 4]);
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub opcode: u8,
    pub serial: u8,
    pub payload: Vec<u8>,
}

pub fn parse(data: &[u8]) -> Result<Packet> {
    let plain = unscramble(data)?;
    if (plain[1] & 31) as usize != plain.len() {
        return Err("响应帧长度不匹配".into());
    }
    if crc8(&plain[..plain.len() - 1]) != plain[plain.len() - 1] {
        return Err("响应 CRC 校验失败".into());
    }
    Ok(Packet {
        opcode: plain[0],
        serial: plain[2],
        payload: plain[4..plain.len() - 1].to_vec(),
    })
}

pub fn frame(
    opcode: u8,
    payload: &[u8],
    serial: u8,
    nonce: u8,
    length: Option<u8>,
) -> Result<Vec<u8>> {
    if payload.len() > 15 {
        return Err("单帧数据超过 15 字节".into());
    }
    let mut plain = vec![
        opcode,
        length.unwrap_or((payload.len() + 5) as u8),
        serial,
        nonce,
    ];
    if (plain[1] & 31) as usize != payload.len() + 5 {
        return Err("长度字段与数据不一致".into());
    }
    plain.extend_from_slice(payload);
    plain.push(crc8(&plain));
    scramble(&plain)
}

pub fn query(
    opcode: u8,
    payload: &[u8],
    serial: u8,
    nonce: u8,
    gen2_allowed: bool,
) -> Result<Vec<u8>> {
    let identification = match opcode {
        0x91 => payload.is_empty(),
        0x90 => payload.len() == 1 && payload[0] < 8,
        0xb0 => payload.len() == 2 && payload[0] < 8 && (1..=7).contains(&payload[1]),
        _ => false,
    };
    let setting = gen2_allowed
        && match opcode {
            0xb1..=0xb4 | 0xb6 | 0xb7 => payload.len() == 1 && payload[0] < 32,
            0xb5 => payload.len() == 2 && payload[0] < 32 && payload[1] < 8,
            _ => false,
        };
    if !identification && !setting {
        return Err("不允许的配置查询".into());
    }
    frame(opcode, payload, serial, nonce, None)
}

pub fn save_serial(chunk: u8, counter: u32) -> Result<u8> {
    if chunk > 15 {
        return Err("分片索引超过范围".into());
    }
    Ok((((counter % 2) as u8) << 7) | (chunk << 3) | (counter % 8) as u8)
}
pub fn host_length(len: usize, counter: u8) -> Result<u8> {
    if len > 15 {
        return Err("单帧数据超过 15 字节".into());
    }
    Ok(if len == 0 {
        5
    } else {
        ((counter % 8) << 5) | ((len + 5) as u8)
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
    pub vid: String,
    pub pid: String,
    pub version_display: String,
    pub mode: u8,
    pub generation: u8,
    #[serde(default)]
    pub sensor: u8,
}
impl Identity {
    pub fn effective_generation(&self) -> u8 {
        if self.generation == 2 && matches!(self.mode, 0 | 7 | 8) {
            1
        } else {
            self.generation
        }
    }
    pub fn is_verified_137(&self) -> bool {
        self.vid == "1005"
            && self.pid == "2001"
            && self.version_display == "1.37"
            && self.mode == 6
            && self.generation == 2
    }
    pub fn is_oplus_id(&self) -> bool {
        self.vid.eq_ignore_ascii_case("1005") && self.pid.eq_ignore_ascii_case("2001")
    }
    pub fn verified(&self) -> bool {
        self.is_verified_137()
    }
    pub fn parse(payload: &[u8]) -> Result<Self> {
        let Some(&declared) = payload.first() else {
            return Err("身份记录为空".into());
        };
        let declared = declared as usize;
        if declared < 6 || payload.len() != declared + 1 {
            return Err("身份记录不完整或长度不匹配".into());
        }
        let p = &payload[1..];
        let (mode, generation, sensor) = if declared == 7 {
            (p[6] & 15, p[6] >> 5, (p[6] >> 4) & 1)
        } else {
            (0, 0, 0)
        };
        Ok(Self {
            vid: hex::encode_upper(&p[..2]),
            pid: hex::encode_upper(&p[2..4]),
            version_display: format!("{:X}.{:02X}", p[4], p[5]),
            mode,
            generation,
            sensor,
        })
    }
}

pub fn name_claims_oplus(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["o+", "oplus", "o plus", "致动o", "zd o"]
        .iter()
        .any(|needle| lower.contains(needle))
}

pub fn decode_keys(data: &[u8]) -> Result<Vec<u8>> {
    if data.is_empty() {
        return Ok(vec![]);
    }
    let count = data[0] as usize;
    let mut keys: Vec<u8> = vec![];
    for &b in &data[1..] {
        if keys.len() >= count {
            break;
        }
        if b & 128 != 0 {
            let run = (b & 127) as usize;
            if keys.is_empty() || run == 0 {
                return Err("无效压缩按键表".into());
            }
            for _ in 1..run {
                let last = keys.last().copied().unwrap();
                keys.push(last.checked_add(1).ok_or("按键码溢出")?);
            }
        } else {
            keys.push(b);
        }
    }
    if keys.len() != count {
        return Err("按键表数量不匹配".into());
    }
    Ok(keys)
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BatteryStatus {
    pub level: u8,
    pub charging: bool,
    pub raw_status: u8,
}

/// Builds the fixed 3-byte KeyLinker power/status enter (`0x1D 02 DF AB`) or exit (`0x1E 02 DF AB`) frame.
pub fn power_control_frame(stop: bool, serial: u8, nonce: u8) -> Result<Vec<u8>> {
    let opcode = if stop { 0x1e } else { 0x1d };
    frame(opcode, &[0x02, 0xdf, 0xab], serial, nonce, None)
}

/// Decodes the 4-bar battery gauge (`1..=4`) and charging flag from a `0x1D 02 DF AB` `0x19` reply payload.
/// Verified against live ZD O+ captures (`0x40` wireless 3/4, `0x50` USB charging 3/4) and KeyLinker (`0x90` charging 4/4).
pub fn parse_power_reply(payload: &[u8]) -> Option<BatteryStatus> {
    if payload.len() < 5 || payload[1] != 0xdf || payload[2] != 0xaa {
        return None;
    }
    let status = payload[4];
    let charging = (status & 0x10) != 0;
    let level = if (status & 0x80) != 0 {
        4
    } else if (status & 0x40) != 0 {
        3
    } else if (status & 0x20) != 0 {
        2
    } else {
        1
    };
    Some(BatteryStatus {
        level,
        charging,
        raw_status: status,
    })
}

pub fn decode_macro_limits(data: &[u8]) -> Result<Vec<u16>> {
    if !data.len().is_multiple_of(2) {
        return Err("每槽宏步数记录长度无效".into());
    }
    Ok(data
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_golden_frames() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/protocol.json")).unwrap();
        for f in v["frames"].as_array().unwrap() {
            let payload = hex::decode(f["payload"].as_str().unwrap()).unwrap();
            let wire = frame(
                f["opcode"].as_u64().unwrap() as u8,
                &payload,
                f["serial"].as_u64().unwrap() as u8,
                f["nonce"].as_u64().unwrap() as u8,
                Some(f["length"].as_u64().unwrap() as u8),
            )
            .unwrap();
            assert_eq!(hex::encode(&wire), f["wire"].as_str().unwrap());
            let p = parse(&wire).unwrap();
            assert_eq!(p.payload, payload);
        }
    }
    #[test]
    fn malformed_and_unverified_queries_rejected() {
        for n in 0..5 {
            assert!(parse(&vec![0; n]).is_err());
        }
        let mut wire = frame(0x19, &[1, 2, 3], 129, 42, None).unwrap();
        *wire.last_mut().unwrap() ^= 1;
        assert!(parse(&wire).is_err());
        assert!(query(0xb5, &[0, 0], 1, 0, false).is_err());
        assert!(query(0xb5, &[0, 7], 1, 0, true).is_ok());
        assert!(query(0xb5, &[0, 8], 1, 0, true).is_err());
        assert!(query(0xb0, &[0, 6], 1, 0, false).is_ok());
        assert!(query(0xb0, &[0, 7], 1, 0, false).is_ok());
        assert!(query(0xb0, &[0, 8], 1, 0, true).is_err());
        assert!(query(0x1d, &[2, 0xdf, 0xab], 1, 0, true).is_err());
        assert!(query(0x16, &[3, 0xdf, 0xa9, 2], 1, 0, true).is_err());
    }
    #[test]
    fn identity_generations_and_gen1_six_byte_frame() {
        let gen1 = Identity::parse(&[6, 0x10, 0x05, 0x20, 0x00, 0x01, 0x10]).unwrap();
        assert_eq!(gen1.vid, "1005");
        assert_eq!(gen1.version_display, "1.10");
        assert_eq!(gen1.effective_generation(), 0);
        assert!(!gen1.is_verified_137());

        let oplus_137 = Identity::parse(&[7, 0x10, 0x05, 0x20, 0x01, 0x01, 0x37, 0x56]).unwrap();
        assert!(oplus_137.is_verified_137());
        assert_eq!(oplus_137.effective_generation(), 2);

        for mode in [0, 7, 8] {
            let special = Identity {
                vid: "1005".into(),
                pid: "2001".into(),
                version_display: "1.42".into(),
                mode,
                generation: 2,
                sensor: 0,
            };
            assert_eq!(special.effective_generation(), 1);
        }
        assert_eq!(
            decode_macro_limits(&[42, 0, 47, 0, 0, 0]).unwrap(),
            vec![42, 47, 0]
        );
        assert!(decode_macro_limits(&[42, 0, 1]).is_err());

        // Verified ZD O+ wireless (0x40 = 3/4) and USB charging (0x50 = 3/4 charging) + full charging (0x90 = 4/4)
        assert_eq!(
            parse_power_reply(&[0x09, 0xdf, 0xaa, 0x00, 0x40, 0xcd, 0x2e, 0x00, 0x00, 0x5e]),
            Some(BatteryStatus {
                level: 3,
                charging: false,
                raw_status: 0x40
            })
        );
        assert_eq!(
            parse_power_reply(&[0x09, 0xdf, 0xaa, 0x0f, 0x50, 0xe8, 0x00, 0x00, 0x00, 0x5e]),
            Some(BatteryStatus {
                level: 3,
                charging: true,
                raw_status: 0x50
            })
        );
        assert_eq!(
            parse_power_reply(&[0x09, 0xdf, 0xaa, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x5e]),
            Some(BatteryStatus {
                level: 4,
                charging: true,
                raw_status: 0x90
            })
        );
        assert_eq!(parse_power_reply(&[0x02, 0xdf, 0xaa]), None);
    }
}
