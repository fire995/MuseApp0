import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

const DENSE_OPTIONS = [0, 10, 20, 30, 60, 90, 120];

export default function DataCaptureControl() {
    const {
        isSaving, savePath, saveDuration,
        denseMins, setDenseMins, toggleSave,
        exportSavedFile, samplingMode,
        autoSaveEnabled, autoSaveIntervalSec,
    } = useMuseDevice();

    // 倒计时：距离下次自动 flush 还剩多少秒
    const [countdown, setCountdown] = useState(autoSaveIntervalSec);
    const [lastFlushTime, setLastFlushTime] = useState<string | null>(null);
    const countdownRef = useRef(autoSaveIntervalSec);
    const pulseAnim = useRef(new Animated.Value(1)).current;

    // 当采集开始 / interval 变化时，重置倒计时
    useEffect(() => {
        countdownRef.current = autoSaveIntervalSec;
        setCountdown(autoSaveIntervalSec);
    }, [autoSaveIntervalSec, isSaving]);

    // 倒计时 ticker
    useEffect(() => {
        if (!isSaving || !autoSaveEnabled) return;
        const tick = setInterval(() => {
            countdownRef.current -= 1;
            if (countdownRef.current <= 0) {
                // flush 触发
                setLastFlushTime(new Date().toLocaleTimeString());
                countdownRef.current = autoSaveIntervalSec;
                // 脉冲动画提示用户数据已写盘
                Animated.sequence([
                    Animated.timing(pulseAnim, { toValue: 1.15, duration: 150, useNativeDriver: true }),
                    Animated.timing(pulseAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
                ]).start();
            }
            setCountdown(countdownRef.current);
        }, 1000);
        return () => clearInterval(tick);
    }, [isSaving, autoSaveEnabled, autoSaveIntervalSec]);

    const progressWidth = autoSaveIntervalSec > 0
        ? ((autoSaveIntervalSec - countdown) / autoSaveIntervalSec) * 100
        : 100;

    return (
        <View style={s.card}>
            <Text style={s.cardTitle}>💾 数据采集</Text>
            <Text style={s.cardSub}>
                保存内容：EEG 全通道原始波形 · PPG 红外/红光（供 HRV + SpO2 分析）
            </Text>

            <View style={{ marginTop: 10 }}>
                <Text style={s.sliderLabel}>
                    高速采集时长（入睡前）：
                    <Text style={{ color: '#3498DB', fontWeight: '700' }}> {denseMins} 分钟</Text>
                </Text>
                <Text style={s.sliderHint}>
                    ⚡ 高速：EEG 256Hz + PPG，头环约 4–5 小时{'\n'}
                    🌙 之后自动切低功耗模式：EEG ~50Hz，头环可坚持一整晚
                </Text>
                <View style={s.optRow}>
                    {DENSE_OPTIONS.map(v => (
                        <TouchableOpacity
                            key={v}
                            style={[s.optBtn, denseMins === v && s.optBtnOn]}
                            onPress={() => setDenseMins(v)}>
                            <Text style={[s.optText, denseMins === v && { color: '#fff' }]}>{v}m</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </View>

            {isSaving && (
                <View style={[s.modeBadge, samplingMode === 'dense' ? s.modeBadgeDense : s.modeBadgeSparse]}>
                    <Text style={s.modeBadgeText}>
                        {samplingMode === 'dense'
                            ? `⚡ 高速采集中 · 头环 p1035（256Hz）`
                            : '🌙 低功耗采集中 · 头环 p21（~50Hz）'}
                    </Text>
                </View>
            )}

            <TouchableOpacity
                style={[s.saveBtn, isSaving && s.saveBtnOn]}
                onPress={toggleSave}>
                <Text style={s.btnText}>{isSaving ? '⏹ 停止保存' : '💾 开始采集'}</Text>
            </TouchableOpacity>

            {isSaving ? (
                <Text style={{ textAlign: 'center', color: '#EAEAEA', fontSize: 13, marginBottom: 8 }}>
                    ⏳ 已采集: {Math.floor(saveDuration / 60).toString().padStart(2, '0')} 分 {(saveDuration % 60).toString().padStart(2, '0')} 秒
                </Text>
            ) : null}

            {/* 自动保存状态栏（采集中才显示） */}
            {isSaving && autoSaveEnabled ? (
                <Animated.View style={[s.autoSaveBox, { transform: [{ scale: pulseAnim }] }]}>
                    <View style={s.autoSaveHeader}>
                        <Text style={s.autoSaveLabel}>🔄 自动写盘</Text>
                        <Text style={s.autoSaveCountdown}>
                            {countdown > 0 ? `${countdown}s 后写入` : '写入中…'}
                        </Text>
                    </View>
                    {/* 进度条 */}
                    <View style={s.progressTrack}>
                        <View style={[s.progressFill, { width: `${progressWidth}%` }]} />
                    </View>
                    {lastFlushTime ? (
                        <Text style={s.lastFlushText}>✅ 上次写盘：{lastFlushTime}</Text>
                    ) : (
                        <Text style={s.lastFlushText}>等待首次写盘…</Text>
                    )}
                </Animated.View>
            ) : null}

            {isSaving && savePath ? (
                <Text style={s.savePath}>📂 {savePath}</Text>
            ) : null}

            {!isSaving && savePath ? (
                <TouchableOpacity
                    style={s.exportBtn}
                    onPress={exportSavedFile}>
                    <Text style={s.btnText}>📤 导出数据文件</Text>
                </TouchableOpacity>
            ) : null}
        </View>
    );
}

const s = StyleSheet.create({
    card: {
        marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
        borderRadius: 16, padding: 16
    },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },
    cardSub: { fontSize: 11, color: '#555', marginBottom: 10 },

    sliderLabel: { fontSize: 12, color: '#aaa' },
    sliderHint: { fontSize: 11, color: '#555', lineHeight: 17, marginBottom: 10, marginTop: 3 },
    optRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
    optBtn: {
        paddingHorizontal: 13, paddingVertical: 6, borderRadius: 20,
        backgroundColor: '#2A2D3A', borderWidth: 1, borderColor: '#444'
    },
    optBtnOn: { backgroundColor: '#3498DB', borderColor: '#3498DB' },
    optText: { color: '#aaa', fontSize: 12, fontWeight: '600' },

    modeBadge: { padding: 10, borderRadius: 8, marginBottom: 10 },
    modeBadgeDense: { backgroundColor: '#0d1f2d' },
    modeBadgeSparse: { backgroundColor: '#0d1f0d' },
    modeBadgeText: { color: '#aaa', fontSize: 12 },

    saveBtn: {
        backgroundColor: '#2A7DB5', paddingVertical: 12, borderRadius: 10,
        alignItems: 'center', marginBottom: 8
    },
    saveBtnOn: { backgroundColor: '#E74C3C' },
    exportBtn: {
        backgroundColor: '#5D408B', paddingVertical: 12, borderRadius: 10,
        alignItems: 'center', marginTop: 8
    },
    savePath: { fontSize: 11, color: '#555', textAlign: 'center', marginTop: 4 },
    btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    // 自动保存状态盒子
    autoSaveBox: {
        backgroundColor: '#0B1E14', borderRadius: 10, padding: 10,
        marginBottom: 8, borderWidth: 1, borderColor: '#1E5C3A',
    },
    autoSaveHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
    autoSaveLabel: { color: '#4CAF50', fontSize: 12, fontWeight: '700' },
    autoSaveCountdown: { color: '#aaa', fontSize: 12 },
    progressTrack: {
        height: 4, backgroundColor: '#1E3828', borderRadius: 2, overflow: 'hidden', marginBottom: 6
    },
    progressFill: { height: 4, backgroundColor: '#4CAF50', borderRadius: 2 },
    lastFlushText: { fontSize: 10, color: '#4a7a5a' },
});
