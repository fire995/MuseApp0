import { Buffer } from 'buffer';
// @ts-ignore
import FFT from 'fft.js';

/**
 * 解码 Muse EEG 数据包
 * Muse 使用 12-bit 压缩格式，每3字节编码2个12-bit样本
 */
export function decodeEEG(base64Data: string): number[] {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const samples: number[] = [];

    // Muse BLE 数据协议规范：头 2 个字节为 Packet Sequence Number。
    // EEG 数据载荷强制从 index 2 开始进行 12-bit 拆解。
    for (let i = 2; i < buffer.length - 2; i += 3) {
      const byte1 = buffer[i];
      const byte2 = buffer[i + 1];
      const byte3 = buffer[i + 2];

      // 解码第一个 12-bit 样本
      const sample1 = ((byte1 << 4) | (byte2 >> 4)) & 0xFFF;
      // 解码第二个 12-bit 样本
      const sample2 = (((byte2 & 0x0F) << 8) | byte3) & 0xFFF;

      // 转换为有符号值并缩放到 μV
      const voltage1 = (sample1 > 2047 ? sample1 - 4096 : sample1) * 0.48828125;
      const voltage2 = (sample2 > 2047 ? sample2 - 4096 : sample2) * 0.48828125;

      samples.push(voltage1, voltage2);
    }

    return samples;
  } catch (e) {
    console.warn('EEG 解码失败:', e);
    return [];
  }
}

/**
 * 分析频域特征（Theta 和 Alpha 波段能量）
 */
export function analyzeFrequency(samples: number[]): { theta: number; alpha: number } {
  if (samples.length < 16) {
    return { theta: 0, alpha: 0 };
  }

  try {
    // 使用最近的 2^n 个样本进行 FFT
    const fftSize = Math.pow(2, Math.floor(Math.log2(samples.length)));
    const fft = new FFT(fftSize);
    const input = samples.slice(0, fftSize);

    // 归一化输入
    const mean = input.reduce((a, b) => a + b, 0) / input.length;
    const normalized = input.map(v => v - mean);

    const out = fft.createComplexArray();
    fft.realTransform(out, normalized);

    // 计算功率谱
    const power: number[] = [];
    for (let i = 0; i < out.length / 2; i += 2) {
      const real = out[i];
      const imag = out[i + 1];
      power.push(Math.sqrt(real * real + imag * imag));
    }

    // 假设采样率 256Hz，计算频段索引
    const samplingRate = 256;
    const freqResolution = samplingRate / fftSize;

    // Theta: 4-8 Hz
    const thetaStart = Math.floor(4 / freqResolution);
    const thetaEnd = Math.ceil(8 / freqResolution);
    const thetaEnergy = power.slice(thetaStart, thetaEnd).reduce((a, b) => a + b, 0);

    // Alpha: 8-13 Hz
    const alphaStart = Math.floor(8 / freqResolution);
    const alphaEnd = Math.ceil(13 / freqResolution);
    const alphaEnergy = power.slice(alphaStart, alphaEnd).reduce((a, b) => a + b, 0);

    return { theta: thetaEnergy, alpha: alphaEnergy };
  } catch (e) {
    console.warn('频域分析失败:', e);
    return { theta: 0, alpha: 0 };
  }
}

/**
 * 评估信号质量（基于 1 秒内的原始 EEG 数据）
 * 逻辑参考后端：
 * 1. 样本数 < 64 时认为数据不足，返回 50
 * 2. 移除均值（简单的高通滤波效果）
 * 3. 超过 200µV 的样本比例 > 0.3 认为脱落/运动伪迹，返回 0
 * 4. 方差 < 5.0 认为接触不良，返回 50
 * 5. 否则返回 100 - outlier_ratio * 200
 */
export function calculateSignalQuality(samples: number[]): number {
  if (samples.length < 64) {
    return 50;
  }

  // 简单去均值（模拟高通滤波，移除直流偏置）
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const centered = samples.map(v => v - mean);

  // 统计异常值比例（幅值 >= 200µV）
  let outliers = 0;
  let sumSq = 0;

  for (const v of centered) {
    if (Math.abs(v) >= 200.0) {
      outliers++;
    }
    sumSq += v * v;
  }

  const outlierRatio = outliers / centered.length;
  if (outlierRatio > 0.3) {
    return 0; // 运动伪迹太大，判定为不可用
  } // 方差太小 = 接触不良

  const variance = sumSq / centered.length;
  if (variance < 5.0) {
    return 50; // 接触不良，几乎是平直线
  }

  // 根据异常样本比例给出质量分数
  return Math.max(0, Math.floor(100 - outlierRatio * 200));
}