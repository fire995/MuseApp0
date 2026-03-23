import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Switch, Alert } from 'react-native';
import Slider from '@react-native-community/slider';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

// ── 进度条子组件 ─────────────────────────────────
// receives progress/duration/seekMusic from parent to avoid calling useMuseDevice twice
const ProgressBar = ({ position, duration, onSeek }: { position: number, duration: number, onSeek: (v: number) => Promise<void> }) => {
    const fmt = (sec: number) =>
        `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 }}>
            <Text style={s.timeText}>{fmt(position)}</Text>
            <Slider
                style={s.slider}
                minimumValue={0}
                maximumValue={duration > 0 ? duration : 1}
                value={position}
                minimumTrackTintColor="#3498DB"
                maximumTrackTintColor="#2A2D3A"
                thumbTintColor="#3498DB"
                onSlidingComplete={onSeek}
            />
            <Text style={[s.timeText, { textAlign: 'right' }]}>{fmt(duration)}</Text>
        </View>
    );
};

// ── 格式化秒数为 mm分ss秒 ─────────────────────────────
const fmtDuration = (sec: number) =>
    `${Math.floor(sec / 60).toString().padStart(2, '0')}分${(sec % 60).toString().padStart(2, '0')}秒`;

// ── 格式化秒数为 mm:ss ────────────────────────────────
const fmtMmSs = (sec: number) =>
    `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;

// ── 主组件 ───────────────────────────────────────────
export default function MeditationPlayer() {
    const {
        musicName, togglePlay, isPlaying,
        musicProgress, musicDuration, seekMusic,
        isSleepRecordMode, setIsSleepRecordMode,
        meditationSessionActive, isMeditationCapturing, meditationRecordDuration,
        isSleepRecording, sleepRecordDuration, sleepMusicSegments,
        startMeditationSession, endMeditationSession,
        startSleepRecord, endSleepRecord,
    } = useMuseDevice();

    const isSessionActive = meditationSessionActive || isSleepRecording;

    // ── 切换睡眠记录模式 Toggle ───────────────────────
    const handleSleepModeToggle = async (value: boolean) => {
        if (value) {
            // 开启睡眠记录 → 立即开启数据接收
            setIsSleepRecordMode(true);
            await startSleepRecord();
        } else {
            // 如果正在睡眠记录中，询问是否结束
            if (isSleepRecording) {
                Alert.alert(
                    '结束睡眠记录？',
                    '关闭此开关将结束当前睡眠记录并保存数据文件。',
                    [
                        {
                            text: '取消', style: 'cancel',
                            onPress: () => setIsSleepRecordMode(true),
                        },
                        {
                            text: '确认结束并保存', style: 'destructive',
                            onPress: async () => {
                                await endSleepRecord(); // 内部会重置 isSleepRecordMode
                            },
                        },
                    ]
                );
            } else {
                setIsSleepRecordMode(false);
            }
        }
    };

    // ── 播放/暂停按钮逻辑 ─────────────────────────────
    const handlePlayPress = async () => {
        // 冥想模式：首次按下时启动冥想会话
        if (!isSleepRecordMode && !meditationSessionActive) {
            await startMeditationSession();
        }
        await togglePlay();
    };

    // ── 结束按钮 ──────────────────────────────────────
    const handleEnd = async () => {
        if (isSleepRecording) {
            await endSleepRecord();
        } else {
            await endMeditationSession();
        }
    };

    // ── 状态栏文案 ────────────────────────────────────
    const renderStatusBadge = () => {
        if (isSleepRecording) {
            return (
                <View style={[s.statusBadge, s.statusSleep]}>
                    <Text style={s.statusDot}>🌙</Text>
                    <Text style={s.statusText}>
                        休息记录中  {fmtDuration(sleepRecordDuration)}
                    </Text>
                </View>
            );
        }
        if (isMeditationCapturing) {
            return (
                <View style={[s.statusBadge, s.statusMeditation]}>
                    <Text style={s.statusDot}>🧘</Text>
                    <Text style={s.statusText}>
                        冥想记录中  {fmtDuration(meditationRecordDuration)}
                    </Text>
                </View>
            );
        }
        if (meditationSessionActive) {
            return (
                <View style={[s.statusBadge, s.statusPaused]}>
                    <Text style={s.statusDot}>⏸</Text>
                    <Text style={s.statusText}>
                        冥想暂停中  已记录 {fmtDuration(meditationRecordDuration)}
                    </Text>
                </View>
            );
        }
        return null;
    };

    // ── 睡眠模式：音乐片段列表（最近3条）──────────────
    const renderMusicSegments = () => {
        if (!isSleepRecording || sleepMusicSegments.length === 0) return null;
        const displaySegs = sleepMusicSegments.slice(-3);
        return (
            <View style={s.segmentsBox}>
                <Text style={s.segmentsTitle}>🎵 冥想音乐播放记录</Text>
                {displaySegs.map((seg, i) => (
                    <Text key={i} style={s.segmentItem}>
                        {fmtMmSs(seg.startSec)} ~ {seg.endSec != null ? fmtMmSs(seg.endSec) : '进行中…'}
                    </Text>
                ))}
                {isPlaying && (
                    <Text style={[s.segmentItem, { color: '#4CAF50' }]}>
                        {fmtMmSs(sleepMusicSegments[sleepMusicSegments.length - 1]?.endSec ?? 0)} ~ 进行中…
                    </Text>
                )}
            </View>
        );
    };

    return (
        <View style={s.card}>
            {/* ── 标题行 + 模式切换 ── */}
            <View style={s.headerRow}>
                <Text style={s.cardTitle}>🎵 冥想音乐</Text>
                <View style={s.modeToggleRow}>
                    <Text style={[s.modeLabel, isSleepRecordMode && s.modeLabelActive]}>
                        {isSleepRecordMode ? '🌙 休息记录' : '🧘 冥想'}
                    </Text>
                    <Switch
                        value={isSleepRecordMode}
                        onValueChange={handleSleepModeToggle}
                        trackColor={{ false: '#2A5A8B', true: '#6A3DB5' }}
                        thumbColor={isSleepRecordMode ? '#C8A8FF' : '#fff'}
                        // 冥想会话中不可切换
                        disabled={meditationSessionActive && !isSleepRecording}
                    />
                </View>
            </View>

            {/* ── 当前音乐名 ── */}
            <Text style={s.musicName}>{musicName}</Text>

            {/* ── 状态徽章 ── */}
            {renderStatusBadge()}

            {/* ── 睡眠模式：音乐片段 ── */}
            {renderMusicSegments()}

            {/* ── 操作按钮行 ── */}
            <View style={s.btnRow}>
                <TouchableOpacity
                    style={[s.btnPlay, isPlaying && s.btnPlayPaused, { flex: 1 }]}
                    onPress={handlePlayPress}
                >
                    <Text style={s.btnText}>
                        {isPlaying ? '⏸ 暂停' : (isSessionActive ? '▶ 继续' : '▶ 开始冥想')}
                    </Text>
                </TouchableOpacity>

                {isSessionActive && (
                    <TouchableOpacity style={s.btnEnd} onPress={handleEnd}>
                        <Text style={s.btnText}>⏹ 结束</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* ── 进度条 ── */}
            <ProgressBar position={musicProgress} duration={musicDuration} onSeek={seekMusic} />

            {/* ── 模式说明 ── */}
            {!isSessionActive && (
                <Text style={s.hint}>
                    {isSleepRecordMode
                        ? '🌙 休息记录模式：已开始连续接收数据，点击▶可标记冥想音乐时段'
                        : '🧘 冥想模式：点击▶开始冥想并记录，暂停则停止记录'}
                </Text>
            )}
        </View>
    );
}

const s = StyleSheet.create({
    card: {
        marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
        borderRadius: 16, padding: 16,
    },
    headerRow: {
        flexDirection: 'row', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: 6,
    },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700' },
    modeToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    modeLabel: { fontSize: 11, color: '#888' },
    modeLabelActive: { color: '#8E44AD', fontWeight: '700' },

    musicName: { fontSize: 13, color: '#aaa', textAlign: 'center', marginBottom: 10 },

    // 状态徽章
    statusBadge: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, marginBottom: 10,
    },
    statusMeditation: { backgroundColor: '#0C2A1A', borderWidth: 1, borderColor: '#2E7D52' },
    statusSleep: { backgroundColor: '#1A0C2A', borderWidth: 1, borderColor: '#6A3DB5' },
    statusPaused: { backgroundColor: '#1A1A0C', borderWidth: 1, borderColor: '#7D7D2E' },
    statusDot: { fontSize: 14 },
    statusText: { fontSize: 12, color: '#EAEAEA', fontWeight: '600' },

    // 音乐片段列表（睡眠模式）
    segmentsBox: {
        backgroundColor: '#111320', borderRadius: 8, padding: 10, marginBottom: 10,
        borderWidth: 1, borderColor: '#2A1A4A',
    },
    segmentsTitle: { color: '#8E44AD', fontSize: 11, fontWeight: '700', marginBottom: 6 },
    segmentItem: { color: '#aaa', fontSize: 11, fontFamily: 'monospace', marginBottom: 2 },

    // 按钮
    btnRow: { flexDirection: 'row', gap: 10, marginBottom: 0 },
    btnPlay: {
        backgroundColor: '#3498DB', paddingVertical: 11, paddingHorizontal: 22,
        borderRadius: 10, alignItems: 'center',
    },
    btnPlayPaused: { backgroundColor: '#2980B9' },
    btnEnd: {
        backgroundColor: '#922B21', paddingVertical: 11, paddingHorizontal: 18,
        borderRadius: 10, alignItems: 'center',
    },
    btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    // 时间
    timeText: { color: '#888', fontSize: 11, width: 34 },
    slider: { flex: 1, height: 40 },

    // 提示
    hint: { fontSize: 10, color: '#444', marginTop: 10, lineHeight: 14, textAlign: 'center' },
});
