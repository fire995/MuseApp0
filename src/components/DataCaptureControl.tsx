import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

const DENSE_OPTIONS = [0, 10, 20, 30, 60, 90, 120];

export default function DataCaptureControl() {
    const {
        isSaving, savePath, saveDuration,
        denseMins, setDenseMins, toggleSave,
        exportSavedFile, samplingMode
    } = useMuseDevice();

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
                <Text style={{ textAlign: 'center', color: '#EAEAEA', fontSize: 13, marginBottom: 10 }}>
                    ⏳ 已采集: {Math.floor(saveDuration / 60).toString().padStart(2, '0')} 分 {(saveDuration % 60).toString().padStart(2, '0')} 秒
                </Text>
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
    savePath: { fontSize: 11, color: '#555', textAlign: 'center' },
    btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
