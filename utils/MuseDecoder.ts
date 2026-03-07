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
 * 部署滑动窗口 DSP 质检闸门 (Software Quality Gate)
 * 逻辑：基于 256 帧（1秒相当于256Hz）的信号池，计算时域标准差 (STD)
 * 1. 如果样本不足 256，返回宽容度得分 50，避免启动瞬间闪退分
 * 2. 算出去交直流偏置后的时域标准差
 * 3. STD 若跨越 20µV 红线，严格判定为物理脱落/肌电伪影 (返回 0分)
 * 4. STD 在 1µV 以下说明导联悬空或短路死寂，判定失效 (返回 0分)
 * 5. 否则计算健康线性质量分配：越接近红线分数越低。
 */
export function calculateSignalQuality(samples: number[]): number {
  if (samples.length < 256) {
    return 50;
  }

  // 截取最近的 256 帧作为 DSP 信号窗口
  const window = samples.slice(-256);

  // 1. 去直流偏置 (计算均值)
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += window[i];
  }
  const mean = sum / 256;

  // 2. 计算标准差 (Standard Deviation)
  let sumSqDiff = 0;
  for (let i = 0; i < 256; i++) {
    const diff = window[i] - mean;
    sumSqDiff += diff * diff;
  }
  const variance = sumSqDiff / 256;
  const stdDev = Math.sqrt(variance);

  // 3. 质检闸门红线判定
  // 红线：大于 20µV 说明发生了严重的位移、接触不良闪烁或剧烈肌电活动
  if (stdDev > 20.0) {
    return 0;
  }

  // 悬空：低于 1µV 几乎是平直线，通常是不通电的噪点本底
  if (stdDev < 1.0) {
    return 0;
  }

  // 4. 健康转换（1µV - 20µV之间）：
  // 标准差越小代表越纯净脑波 (最高分)，标准差越大逼近运动基线 (分数下降)
  // 当 stdDev = 1 的时候最高 100 分，当 stdDev = 20 的时候为 0 分
  const score = 100 - ((stdDev - 1) / 19) * 100;

  return Math.max(0, Math.min(100, Math.round(score)));
}