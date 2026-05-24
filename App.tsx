import AsyncStorage from '@react-native-async-storage/async-storage';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  cancel as cancelDesktopNotifications,
  isPermissionGranted as isDesktopPermissionGranted,
  requestPermission as requestDesktopPermission,
  Schedule,
  sendNotification as sendDesktopNotification,
} from '@tauri-apps/plugin-notification';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';

const STORAGE_KEY = 'timer-alert-app:v1';
const CHANNEL_ID = 'timer-alerts';
const SECOND = 1000;
const MINUTE = 60 * SECOND;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

type TimerStatus = 'idle' | 'running' | 'paused' | 'done';
type ThemeMode = 'light' | 'dark';

type AlertRule = {
  id: string;
  label: string;
  offsetMs: number;
  fired: boolean;
  notificationId?: string;
  desktopNotificationId?: number;
};

type TimerItem = {
  id: string;
  label: string;
  durationMs: number;
  status: TimerStatus;
  targetAt?: number;
  pausedRemainingMs: number;
  alerts: AlertRule[];
  createdAt: number;
};

type PersistedState = {
  timers: TimerItem[];
  theme: ThemeMode;
};

type Draft = {
  label: string;
  minutes: string;
  warningMinutes: string;
};

const defaultDraft: Draft = {
  label: 'Focus block',
  minutes: '25',
  warningMinutes: '5',
};

const presets = [
  { label: 'Focus', minutes: 25, warning: 5 },
  { label: 'Break', minutes: 5, warning: 1 },
  { label: 'Standup', minutes: 15, warning: 2 },
];

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const isDesktopRuntime = () => {
  try {
    return isTauri();
  } catch {
    return false;
  }
};

const desktopNotificationId = (timerId: string, alertId: string) => {
  const source = `${timerId}:${alertId}`;
  let hash = 0;

  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) | 0;
  }

  return Math.abs(hash) || 1;
};

const clampNumber = (value: string, fallback: number) => {
  const numeric = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
};

const getRemainingMs = (timer: TimerItem, now = Date.now()) => {
  if (timer.status === 'running' && timer.targetAt) {
    return Math.max(0, timer.targetAt - now);
  }

  if (timer.status === 'done') {
    return 0;
  }

  return Math.max(0, timer.pausedRemainingMs);
};

const formatDuration = (ms: number) => {
  const totalSeconds = Math.ceil(Math.max(0, ms) / SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const padded = (value: number) => value.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${padded(minutes)}:${padded(seconds)}`;
  }

  return `${padded(minutes)}:${padded(seconds)}`;
};

const formatOffset = (offsetMs: number) => {
  if (offsetMs === 0) {
    return 'Finish';
  }

  return `${Math.round(offsetMs / MINUTE)}m before`;
};

const getNextAlertText = (timer: TimerItem, remainingMs: number) => {
  const upcoming = timer.alerts
    .filter((rule) => !rule.fired && remainingMs > rule.offsetMs)
    .sort((a, b) => b.offsetMs - a.offsetMs)[0];

  if (!upcoming) {
    return timer.status === 'done' ? 'Completed' : 'Final alert armed';
  }

  return `${upcoming.label} at ${formatOffset(upcoming.offsetMs)}`;
};

const makeAlerts = (durationMs: number, warningMinutes: number): AlertRule[] => {
  const warningMs = Math.round(warningMinutes * MINUTE);
  const alerts: AlertRule[] = [];

  if (warningMs > 0 && warningMs < durationMs) {
    alerts.push({
      id: uid(),
      label: `${Math.round(warningMs / MINUTE)} minute warning`,
      offsetMs: warningMs,
      fired: false,
    });
  }

  alerts.push({
    id: uid(),
    label: 'Time is up',
    offsetMs: 0,
    fired: false,
  });

  return alerts;
};

const palette = {
  light: {
    bg: '#F6F4EF',
    panel: '#FFFFFF',
    panelSoft: '#EEF3F0',
    text: '#171A1F',
    muted: '#6B7280',
    border: '#D8DED8',
    primary: '#1E6F5C',
    primaryText: '#FFFFFF',
    accent: '#C96C3B',
    danger: '#B23A48',
    shadow: '#B8B0A4',
  },
  dark: {
    bg: '#111416',
    panel: '#1B2024',
    panelSoft: '#243036',
    text: '#F3F2ED',
    muted: '#AAB3B2',
    border: '#334148',
    primary: '#63C5A6',
    primaryText: '#07110E',
    accent: '#F0A35E',
    danger: '#FF6B7A',
    shadow: '#000000',
  },
};

export default function App() {
  const [timers, setTimers] = useState<TimerItem[]>([]);
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [draft, setDraft] = useState<Draft>(defaultDraft);
  const [isComposerOpen, setComposerOpen] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState('unknown');
  const [now, setNow] = useState(Date.now());
  const timersRef = useRef<TimerItem[]>([]);
  const colors = palette[theme];
  const styles = useMemo(() => createStyles(colors), [colors]);

  useEffect(() => {
    timersRef.current = timers;
  }, [timers]);

  const persist = useCallback(async (nextTimers: TimerItem[], nextTheme = theme) => {
    const payload: PersistedState = { timers: nextTimers, theme: nextTheme };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [theme]);

  const updateTimers = useCallback((updater: (current: TimerItem[]) => TimerItem[]) => {
    setTimers((current) => {
      const next = updater(current);
      void persist(next);
      return next;
    });
  }, [persist]);

  const requestNotificationAccess = useCallback(async () => {
    if (isDesktopRuntime()) {
      const granted = await isDesktopPermissionGranted();
      const finalStatus = granted ? 'granted' : await requestDesktopPermission();
      const allowed = finalStatus === 'granted';
      setPermissionStatus(allowed ? 'granted' : 'denied');
      return allowed;
    }

    const existing = await Notifications.getPermissionsAsync();
    const finalStatus = existing.granted ? existing : await Notifications.requestPermissionsAsync();
    setPermissionStatus(finalStatus.granted ? 'granted' : 'denied');

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Timer alerts',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        vibrationPattern: [0, 250, 250, 250],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    return finalStatus.granted;
  }, []);

  const cancelTimerNotifications = useCallback(async (timer: TimerItem) => {
    if (isDesktopRuntime()) {
      const desktopIds = timer.alerts
        .map((rule) => rule.desktopNotificationId)
        .filter((notificationId): notificationId is number => typeof notificationId === 'number');

      if (desktopIds.length > 0) {
        await cancelDesktopNotifications(desktopIds).catch(() => undefined);
      }

      return;
    }

    await Promise.all(
      timer.alerts
        .map((rule) => rule.notificationId)
        .filter((notificationId): notificationId is string => Boolean(notificationId))
        .map((notificationId) => Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => undefined)),
    );
  }, []);

  const scheduleTimerNotifications = useCallback(async (timer: TimerItem) => {
    const granted = await requestNotificationAccess();

    if (!granted || !timer.targetAt) {
      return timer;
    }

    if (isDesktopRuntime()) {
      const updatedAlerts = timer.alerts.map((rule) => {
        const triggerAt = timer.targetAt! - rule.offsetMs;

        if (rule.fired || triggerAt <= Date.now()) {
          return rule;
        }

        const notificationId = desktopNotificationId(timer.id, rule.id);
        sendDesktopNotification({
          id: notificationId,
          title: rule.offsetMs === 0 ? `${timer.label} finished` : `${timer.label}: ${rule.label}`,
          body: rule.offsetMs === 0 ? 'Time is up.' : `${formatOffset(rule.offsetMs)} remaining.`,
          schedule: Schedule.at(new Date(triggerAt), false, true),
          sound: 'message-new-instant',
          autoCancel: true,
        });

        return { ...rule, desktopNotificationId: notificationId };
      });

      return { ...timer, alerts: updatedAlerts };
    }

    const updatedAlerts = await Promise.all(
      timer.alerts.map(async (rule) => {
        const triggerAt = timer.targetAt! - rule.offsetMs;

        if (rule.fired || triggerAt <= Date.now()) {
          return rule;
        }

        const notificationId = await Notifications.scheduleNotificationAsync({
          content: {
            title: rule.offsetMs === 0 ? `${timer.label} finished` : `${timer.label}: ${rule.label}`,
            body: rule.offsetMs === 0 ? 'Time is up.' : `${formatOffset(rule.offsetMs)} remaining.`,
            sound: 'default',
            data: { timerId: timer.id, alertId: rule.id },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(triggerAt),
            channelId: CHANNEL_ID,
          },
        });

        return { ...rule, notificationId };
      }),
    );

    return { ...timer, alerts: updatedAlerts };
  }, [requestNotificationAccess]);

  const markAlertFired = useCallback((timerId: string, alertId: string) => {
    updateTimers((current) =>
      current.map((timer) => {
        if (timer.id !== timerId) {
          return timer;
        }

        const alerts = timer.alerts.map((rule) =>
          rule.id === alertId ? { ...rule, fired: true, notificationId: undefined } : rule,
        ).map((rule) =>
          rule.id === alertId ? { ...rule, desktopNotificationId: undefined } : rule,
        );
        const allFired = alerts.every((rule) => rule.fired);

        return {
          ...timer,
          alerts,
          status: allFired && getRemainingMs(timer) === 0 ? 'done' : timer.status,
          pausedRemainingMs: allFired && getRemainingMs(timer) === 0 ? 0 : timer.pausedRemainingMs,
        };
      }),
    );
  }, [updateTimers]);

  const showForegroundAlert = useCallback((timerId: string, alertId: string) => {
    const timer = timersRef.current.find((item) => item.id === timerId);
    const rule = timer?.alerts.find((item) => item.id === alertId);

    if (!timer || !rule || rule.fired) {
      return;
    }

    Vibration.vibrate(rule.offsetMs === 0 ? [0, 300, 160, 300] : 250);
    Alert.alert(rule.offsetMs === 0 ? 'Time is up' : rule.label, `${timer.label} · ${formatOffset(rule.offsetMs)}`);
    markAlertFired(timer.id, rule.id);
  }, [markAlertFired]);

  useEffect(() => {
    const loadState = async () => {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      await requestNotificationAccess();

      if (!stored) {
        return;
      }

      const parsed = JSON.parse(stored) as PersistedState;
      setTheme(parsed.theme ?? 'light');
      setTimers(
        (parsed.timers ?? []).map((timer) => {
          const remainingMs = getRemainingMs(timer);
          const shouldBeDone = timer.status === 'running' && remainingMs === 0;

          return {
            ...timer,
            status: shouldBeDone ? 'done' : timer.status,
            pausedRemainingMs: shouldBeDone ? 0 : remainingMs,
            alerts: timer.alerts.map((rule) => ({
              ...rule,
              fired: shouldBeDone && rule.offsetMs === 0 ? true : rule.fired,
            })),
          };
        }),
      );
    };

    void loadState();
  }, [requestNotificationAccess]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return undefined;
    }

    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void getCurrentWindow().hide();
    }).then((handler) => {
      unlisten = handler;
    });

    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, SECOND);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const { timerId, alertId } = notification.request.content.data ?? {};

      if (typeof timerId === 'string' && typeof alertId === 'string') {
        showForegroundAlert(timerId, alertId);
      }
    });

    return () => subscription.remove();
  }, [showForegroundAlert]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }

    timersRef.current.forEach((timer) => {
      if (timer.status !== 'running') {
        return;
      }

      const remainingMs = getRemainingMs(timer, now);
      timer.alerts.forEach((rule) => {
        if (!rule.fired && remainingMs <= rule.offsetMs) {
          showForegroundAlert(timer.id, rule.id);
        }
      });
    });
  }, [now, showForegroundAlert]);

  useEffect(() => {
    setTimers((current) => {
      let changed = false;
      const next = current.map((timer) => {
        if (timer.status !== 'running' || getRemainingMs(timer, now) > 0) {
          return timer;
        }

        changed = true;
        return {
          ...timer,
          status: 'done' as const,
          pausedRemainingMs: 0,
          alerts: timer.alerts.map((rule) => (rule.offsetMs === 0 ? { ...rule, fired: true } : rule)),
        };
      });

      if (changed) {
        void persist(next);
      }

      return changed ? next : current;
    });
  }, [now, persist]);

  const toggleTheme = async () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    await persist(timers, nextTheme);
  };

  const createTimer = async (source: Draft) => {
    const durationMinutes = clampNumber(source.minutes, 25);
    const warningMinutes = clampNumber(source.warningMinutes, Math.max(1, Math.floor(durationMinutes / 5)));
    const durationMs = Math.round(durationMinutes * MINUTE);
    const timer: TimerItem = {
      id: uid(),
      label: source.label.trim() || 'Timer',
      durationMs,
      status: 'idle',
      pausedRemainingMs: durationMs,
      alerts: makeAlerts(durationMs, warningMinutes),
      createdAt: Date.now(),
    };

    updateTimers((current) => [timer, ...current]);
    setDraft(defaultDraft);
    setComposerOpen(false);
  };

  const startTimer = async (timer: TimerItem) => {
    await cancelTimerNotifications(timer);
    const remainingMs = getRemainingMs(timer);
    const runningTimer: TimerItem = {
      ...timer,
      status: 'running',
      targetAt: Date.now() + remainingMs,
      pausedRemainingMs: remainingMs,
      alerts: timer.alerts.map((rule) => ({
        ...rule,
        fired: false,
        notificationId: undefined,
        desktopNotificationId: undefined,
      })),
    };
    const scheduled = await scheduleTimerNotifications(runningTimer);
    updateTimers((current) => current.map((item) => (item.id === timer.id ? scheduled : item)));
  };

  const pauseTimer = async (timer: TimerItem) => {
    await cancelTimerNotifications(timer);
    updateTimers((current) =>
      current.map((item) =>
        item.id === timer.id
          ? {
              ...item,
              status: 'paused',
              pausedRemainingMs: getRemainingMs(item),
              targetAt: undefined,
              alerts: item.alerts.map((rule) => ({
                ...rule,
                notificationId: undefined,
                desktopNotificationId: undefined,
              })),
            }
          : item,
      ),
    );
  };

  const resetTimer = async (timer: TimerItem) => {
    await cancelTimerNotifications(timer);
    updateTimers((current) =>
      current.map((item) =>
        item.id === timer.id
          ? {
              ...item,
              status: 'idle',
              targetAt: undefined,
              pausedRemainingMs: item.durationMs,
              alerts: item.alerts.map((rule) => ({
                ...rule,
                fired: false,
                notificationId: undefined,
                desktopNotificationId: undefined,
              })),
            }
          : item,
      ),
    );
  };

  const deleteTimer = async (timer: TimerItem) => {
    await cancelTimerNotifications(timer);
    updateTimers((current) => current.filter((item) => item.id !== timer.id));
  };

  const addPreset = async (preset: (typeof presets)[number]) => {
    await createTimer({
      label: preset.label,
      minutes: String(preset.minutes),
      warningMinutes: String(preset.warning),
    });
  };

  const runningCount = timers.filter((timer) => timer.status === 'running').length;
  const nextTimer = timers
    .filter((timer) => timer.status === 'running')
    .sort((a, b) => getRemainingMs(a, now) - getRemainingMs(b, now))[0];

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View>
            <Text style={styles.kicker}>Timer desk</Text>
            <Text style={styles.title}>Alertboard</Text>
          </View>
          <View style={styles.themeControl}>
            <Text style={styles.themeLabel}>{theme === 'light' ? 'Light' : 'Dark'}</Text>
            <Switch
              value={theme === 'dark'}
              onValueChange={toggleTheme}
              thumbColor={colors.primary}
              trackColor={{ false: colors.border, true: colors.panelSoft }}
            />
          </View>
        </View>

        <View style={styles.summary}>
          <View>
            <Text style={styles.summaryLabel}>Next alert</Text>
            <Text style={styles.summaryTime}>{nextTimer ? formatDuration(getRemainingMs(nextTimer, now)) : '--:--'}</Text>
            <Text style={styles.summaryHint}>{nextTimer ? nextTimer.label : 'No active countdowns'}</Text>
          </View>
          <View style={styles.summaryPill}>
            <Text style={styles.summaryPillNumber}>{runningCount}</Text>
            <Text style={styles.summaryPillText}>running</Text>
          </View>
        </View>

        <View style={styles.actionsRow}>
          <Pressable style={styles.primaryButton} onPress={() => setComposerOpen(true)}>
            <Text style={styles.primaryButtonText}>New timer</Text>
          </Pressable>
          {presets.map((preset) => (
            <Pressable key={preset.label} style={styles.secondaryButton} onPress={() => addPreset(preset)}>
              <Text style={styles.secondaryButtonText}>{preset.label}</Text>
            </Pressable>
          ))}
        </View>

        {permissionStatus === 'denied' ? (
          <View style={styles.warningPanel}>
            <Text style={styles.warningTitle}>Notifications are off</Text>
            <Text style={styles.warningText}>Enable notifications to receive sound and popup alerts in the background.</Text>
          </View>
        ) : null}

        <View style={styles.timerList}>
          {timers.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>Build your first countdown</Text>
              <Text style={styles.emptyText}>Create a timer, set a warning point, then leave the app. Local notifications keep the alarm armed.</Text>
            </View>
          ) : (
            timers.map((timer) => {
              const remainingMs = getRemainingMs(timer, now);
              const progress = timer.durationMs === 0 ? 0 : 1 - remainingMs / timer.durationMs;

              return (
                <View key={timer.id} style={styles.timerCard}>
                  <View style={styles.cardTop}>
                    <View>
                      <Text style={styles.timerLabel}>{timer.label}</Text>
                      <Text style={styles.timerMeta}>{getNextAlertText(timer, remainingMs)}</Text>
                    </View>
                    <View style={[styles.statusBadge, timer.status === 'running' && styles.statusBadgeActive]}>
                      <Text style={[styles.statusBadgeText, timer.status === 'running' && styles.statusBadgeTextActive]}>
                        {timer.status}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.timerTime}>{formatDuration(remainingMs)}</Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.max(0, Math.min(1, progress)) * 100}%` }]} />
                  </View>

                  <View style={styles.alertRow}>
                    {timer.alerts.map((rule) => (
                      <View key={rule.id} style={[styles.alertChip, rule.fired && styles.alertChipFired]}>
                        <Text style={[styles.alertChipText, rule.fired && styles.alertChipTextFired]}>
                          {rule.fired ? 'Done' : formatOffset(rule.offsetMs)}
                        </Text>
                      </View>
                    ))}
                  </View>

                  <View style={styles.cardActions}>
                    {timer.status === 'running' ? (
                      <Pressable style={styles.cardButton} onPress={() => pauseTimer(timer)}>
                        <Text style={styles.cardButtonText}>Pause</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        style={[styles.cardButton, styles.cardButtonPrimary]}
                        onPress={() => startTimer(timer)}
                        disabled={timer.status === 'done' && remainingMs === 0}
                      >
                        <Text style={[styles.cardButtonText, styles.cardButtonTextPrimary]}>
                          {timer.status === 'paused' ? 'Resume' : 'Start'}
                        </Text>
                      </Pressable>
                    )}
                    <Pressable style={styles.cardButton} onPress={() => resetTimer(timer)}>
                      <Text style={styles.cardButtonText}>Reset</Text>
                    </Pressable>
                    <Pressable style={styles.deleteButton} onPress={() => deleteTimer(timer)}>
                      <Text style={styles.deleteButtonText}>Delete</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      <Modal visible={isComposerOpen} animationType="slide" transparent onRequestClose={() => setComposerOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalShell}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New countdown</Text>
            <TextInput
              value={draft.label}
              onChangeText={(label) => setDraft((current) => ({ ...current, label }))}
              placeholder="Label"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
            <View style={styles.inputRow}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Duration minutes</Text>
                <TextInput
                  value={draft.minutes}
                  onChangeText={(minutes) => setDraft((current) => ({ ...current, minutes }))}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Warn before</Text>
                <TextInput
                  value={draft.warningMinutes}
                  onChangeText={(warningMinutes) => setDraft((current) => ({ ...current, warningMinutes }))}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />
              </View>
            </View>
            <View style={styles.modalActions}>
              <Pressable style={styles.secondaryButton} onPress={() => setComposerOpen(false)}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.primaryButton} onPress={() => createTimer(draft)}>
                <Text style={styles.primaryButtonText}>Create</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (colors: (typeof palette)[ThemeMode]) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    content: {
      gap: 18,
      padding: 20,
      paddingBottom: 48,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    kicker: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '700',
      letterSpacing: 0,
      textTransform: 'uppercase',
    },
    title: {
      color: colors.text,
      fontSize: 36,
      fontWeight: '800',
      letterSpacing: 0,
    },
    themeControl: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    themeLabel: {
      color: colors.muted,
      fontSize: 13,
      fontWeight: '700',
    },
    summary: {
      alignItems: 'center',
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: 1,
      elevation: 2,
      flexDirection: 'row',
      justifyContent: 'space-between',
      padding: 20,
      shadowColor: colors.shadow,
      shadowOpacity: 0.14,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 10 },
    },
    summaryLabel: {
      color: colors.muted,
      fontSize: 14,
      fontWeight: '700',
    },
    summaryTime: {
      color: colors.text,
      fontSize: 46,
      fontVariant: ['tabular-nums'],
      fontWeight: '900',
      letterSpacing: 0,
    },
    summaryHint: {
      color: colors.muted,
      fontSize: 15,
      fontWeight: '600',
    },
    summaryPill: {
      alignItems: 'center',
      backgroundColor: colors.panelSoft,
      borderRadius: 8,
      minWidth: 86,
      padding: 12,
    },
    summaryPillNumber: {
      color: colors.primary,
      fontSize: 28,
      fontWeight: '900',
    },
    summaryPillText: {
      color: colors.muted,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
    },
    actionsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    primaryButton: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 8,
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: 18,
      paddingVertical: 12,
    },
    primaryButtonText: {
      color: colors.primaryText,
      fontSize: 15,
      fontWeight: '800',
    },
    secondaryButton: {
      alignItems: 'center',
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: 1,
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: 16,
      paddingVertical: 11,
    },
    secondaryButtonText: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '800',
    },
    warningPanel: {
      backgroundColor: colors.panel,
      borderColor: colors.accent,
      borderRadius: 8,
      borderWidth: 1,
      padding: 14,
    },
    warningTitle: {
      color: colors.accent,
      fontSize: 15,
      fontWeight: '900',
    },
    warningText: {
      color: colors.muted,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 4,
    },
    timerList: {
      gap: 14,
    },
    emptyState: {
      alignItems: 'center',
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: 1,
      padding: 24,
    },
    emptyTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '900',
      textAlign: 'center',
    },
    emptyText: {
      color: colors.muted,
      fontSize: 14,
      lineHeight: 21,
      marginTop: 8,
      textAlign: 'center',
    },
    timerCard: {
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: 1,
      padding: 16,
    },
    cardTop: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 10,
      justifyContent: 'space-between',
    },
    timerLabel: {
      color: colors.text,
      fontSize: 20,
      fontWeight: '900',
    },
    timerMeta: {
      color: colors.muted,
      fontSize: 13,
      fontWeight: '600',
      marginTop: 3,
    },
    statusBadge: {
      backgroundColor: colors.panelSoft,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    statusBadgeActive: {
      backgroundColor: colors.primary,
    },
    statusBadgeText: {
      color: colors.muted,
      fontSize: 12,
      fontWeight: '900',
      textTransform: 'uppercase',
    },
    statusBadgeTextActive: {
      color: colors.primaryText,
    },
    timerTime: {
      color: colors.text,
      fontSize: 48,
      fontVariant: ['tabular-nums'],
      fontWeight: '900',
      letterSpacing: 0,
      marginTop: 10,
    },
    progressTrack: {
      backgroundColor: colors.panelSoft,
      borderRadius: 6,
      height: 9,
      marginTop: 8,
      overflow: 'hidden',
    },
    progressFill: {
      backgroundColor: colors.primary,
      borderRadius: 6,
      height: 9,
    },
    alertRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 12,
    },
    alertChip: {
      backgroundColor: colors.panelSoft,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    alertChipFired: {
      backgroundColor: colors.primary,
    },
    alertChipText: {
      color: colors.muted,
      fontSize: 12,
      fontWeight: '800',
    },
    alertChipTextFired: {
      color: colors.primaryText,
    },
    cardActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 14,
    },
    cardButton: {
      alignItems: 'center',
      backgroundColor: colors.panelSoft,
      borderRadius: 8,
      minHeight: 40,
      justifyContent: 'center',
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    cardButtonPrimary: {
      backgroundColor: colors.primary,
    },
    cardButtonText: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '800',
    },
    cardButtonTextPrimary: {
      color: colors.primaryText,
    },
    deleteButton: {
      alignItems: 'center',
      backgroundColor: 'transparent',
      borderColor: colors.danger,
      borderRadius: 8,
      borderWidth: 1,
      minHeight: 40,
      justifyContent: 'center',
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    deleteButtonText: {
      color: colors.danger,
      fontSize: 14,
      fontWeight: '800',
    },
    modalShell: {
      backgroundColor: 'rgba(0,0,0,0.42)',
      flex: 1,
      justifyContent: 'flex-end',
    },
    modalCard: {
      backgroundColor: colors.panel,
      borderTopLeftRadius: 8,
      borderTopRightRadius: 8,
      gap: 14,
      padding: 20,
    },
    modalTitle: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '900',
    },
    input: {
      backgroundColor: colors.panelSoft,
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: 1,
      color: colors.text,
      fontSize: 16,
      fontWeight: '700',
      minHeight: 48,
      paddingHorizontal: 12,
    },
    inputRow: {
      flexDirection: 'row',
      gap: 10,
    },
    inputGroup: {
      flex: 1,
      gap: 7,
    },
    inputLabel: {
      color: colors.muted,
      fontSize: 13,
      fontWeight: '800',
    },
    modalActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 10,
    },
  });
