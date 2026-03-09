import { EEG_SAMPLE_RATE } from '../../utils/MuseDecoder';

export interface AnalysisResults {
    timestamp: number;
    type: 'meditation' | 'nap' | 'sleep';
    durationSec: number;
    solMinutes: number | null; // Sleep Onset Latency
    avgThetaAlphaRatio: number;
    peakThetaAlphaRatio: number;
    avgRMSSD: number | null;  // Heart Rate Variability metric
    crossoverPoints: number;   // Number of times Theta crossed Alpha
    thetaAlphaSeries: number[]; // For charting
    hrvSeries: number[];        // For charting
}

/**
 * SessionAnalyzer handles post-session data processing.
 * It parses the raw Mind-Monitor strings and extracts meaningful metrics.
 */
export class SessionAnalyzer {
    /**
     * Parses the raw data string (CSV/Lines) recorded during a session.
     * Line format expected: ISO_TIME,OSC_ADDRESS,ARGS_JSON
     */
    static async analyze(rawData: string, type: 'meditation' | 'nap' | 'sleep'): Promise<AnalysisResults> {
        const lines = rawData.split('\n');
        const thetaAlphaSeries: number[] = [];
        const hrvSeries: number[] = [];
        let totalRMSSD = 0;
        let rmssdCount = 0;
        let crossoverPoints = 0;
        let lastRatio = 0;

        // Mocking some logic for now based on the structure of Mind-Monitor data
        // In a real scenario, we'd iterate through lines and parse EEG/PPG values.

        // Dummy processing to demonstrate the structure
        const durationSec = Math.min(lines.length / 5, 3600); // 假设 5 行一秒

        let solMinutes = null;
        if (type !== 'meditation') {
            solMinutes = Math.floor(Math.random() * 15) + 5; // Mock SOL
        }

        // Generate synthetic series for charts if data is sparse (for demo)
        for (let i = 0; i < 50; i++) {
            const ratio = 0.5 + Math.random() * 1.5;
            thetaAlphaSeries.push(ratio);
            if (lastRatio < 1.0 && ratio >= 1.0) crossoverPoints++;
            lastRatio = ratio;

            hrvSeries.push(40 + Math.random() * 30);
        }

        const avgRMSSD = hrvSeries.length > 0
            ? hrvSeries.reduce((a, b) => a + b, 0) / hrvSeries.length
            : null;

        return {
            timestamp: Date.now(),
            type,
            durationSec,
            solMinutes,
            avgThetaAlphaRatio: thetaAlphaSeries.reduce((a, b) => a + b, 0) / thetaAlphaSeries.length,
            peakThetaAlphaRatio: Math.max(...thetaAlphaSeries),
            avgRMSSD,
            crossoverPoints,
            thetaAlphaSeries,
            hrvSeries,
        };
    }
}
