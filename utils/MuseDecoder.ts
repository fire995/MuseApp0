import { Buffer } from 'buffer';
// @ts-ignore
import FFT from 'fft.js';

// 核心逻辑：Muse 2 每包 20 字节，包含 1 个 16位序号和 12 个 12位采样点
export const decodeEEG = (base64: string): number[] => {
  const buf = Buffer.from(base64, 'base64');
  const samples: number[] = [];
  // 跳过前 2 字节序号
  let bitIndex = 16; 
  for (let i = 0; i < 12; i++) {
    // 提取 12-bit 采样
    const bytePos = Math.floor(bitIndex / 8);
    const bitOff  = bitIndex % 8;
    // 跨字节读取 12 位
    const val = (
      (buf[bytePos] << 16 | buf[bytePos + 1] << 8 | buf[bytePos + 2]) 
      >> (24 - 12 - bitOff)
    ) & 0xFFF;
    
    // 转换为微伏 (公式：(val - 2048) * 0.488)
    samples.push((val - 2048) * 0.488);
    bitIndex += 12;
  }
  return samples;
};

// 简单的4-8Hz带通滤波器（Theta波段）
export const filterThetaBand = (samples: number[]): number[] => {
  // 为了简化处理，这里只是简单地对数据进行平滑处理
  // 在实际应用中，可以使用更复杂的滤波器算法
  const smoothed: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const start = Math.max(0, i - 2);
    const end = Math.min(samples.length - 1, i + 2);
    let sum = 0;
    for (let j = start; j <= end; j++) {
      sum += samples[j];
    }
    smoothed.push(sum / (end - start + 1));
  }
  return smoothed;
};

// 简单的8-13Hz带通滤波器（Alpha波段）
export const filterAlphaBand = (samples: number[]): number[] => {
  // 这里同样使用简单的平滑处理
  const smoothed: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const start = Math.max(0, i - 1);
    const end = Math.min(samples.length - 1, i + 1);
    let sum = 0;
    for (let j = start; j <= end; j++) {
      sum += samples[j];
    }
    smoothed.push(sum / (end - start + 1));
  }
  return smoothed;
};

// 使用FFT进行频域分析
export const analyzeFrequency = (samples: number[], sampleRate: number = 256): { theta: number, alpha: number } => {
  // 确保样本数量是2的幂
  const n = nextPowerOf2(samples.length);
  const fft = new FFT(n);
  
  // 补零到n长度
  const paddedSamples = [...samples, ...new Array(n - samples.length).fill(0)];
  
  // 创建复数数组
  const complexArray = fft.createComplexArray();
  for (let i = 0; i < n; i++) {
    complexArray[2 * i] = paddedSamples[i] || 0;  // 实部
    complexArray[2 * i + 1] = 0;                 // 虚部
  }
  
  // 执行FFT
  const transformed = fft.createComplexArray();
  fft.transform(transformed, complexArray);
  
  // 计算功率谱密度
  const magnitude = new Array(n / 2).fill(0);
  for (let i = 0; i < n / 2; i++) {
    magnitude[i] = Math.sqrt(
      Math.pow(transformed[2 * i], 2) + 
      Math.pow(transformed[2 * i + 1], 2)
    );
  }
  
  // 计算4-8Hz范围内的能量（Theta波段）
  const binSize = sampleRate / n;
  const thetaLowFreqBin = Math.floor(4 / binSize);
  const thetaHighFreqBin = Math.floor(8 / binSize);
  
  // 计算8-13Hz范围内的能量（Alpha波段）
  const alphaLowFreqBin = Math.floor(8 / binSize);
  const alphaHighFreqBin = Math.floor(13 / binSize);
  
  let thetaEnergy = 0;
  let alphaEnergy = 0;
  let totalEnergy = 0;
  
  for (let i = 1; i < magnitude.length; i++) { // 跳过直流分量
    totalEnergy += magnitude[i];
    if (i >= thetaLowFreqBin && i <= thetaHighFreqBin) {
      thetaEnergy += magnitude[i];
    }
    if (i >= alphaLowFreqBin && i <= alphaHighFreqBin) {
      alphaEnergy += magnitude[i];
    }
  }
  
  return {
    theta: totalEnergy > 0 ? thetaEnergy / totalEnergy : 0,
    alpha: totalEnergy > 0 ? alphaEnergy / totalEnergy : 0
  };
};

// 计算下一个2的幂
const nextPowerOf2 = (n: number): number => {
  let power = 1;
  while (power < n) {
    power <<= 1;
  }
  return power;
};