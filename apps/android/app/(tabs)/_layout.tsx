import { Tabs } from 'expo-router/js-tabs';
import { useClientState } from '../../src/connection/context.tsx';
import { TABS } from '../../src/tabs.ts';
import { colors } from '../../src/theme.ts';
import { Icon } from '../../src/ui/Icon.tsx';

export default function TabsLayout() {
  const state = useClientState();
  const waiting = state.actions.filter((a) => a.status === 'pending').length;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.s0 },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.text3,
        tabBarActiveBackgroundColor: colors.s3,
        tabBarStyle: { backgroundColor: colors.s1, borderTopColor: colors.line },
        tabBarLabelStyle: { fontSize: 12 },
        tabBarBadgeStyle: { backgroundColor: colors.s4, color: colors.text },
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.title,
            tabBarIcon: ({ color }) => <Icon name={t.icon} size={24} color={color} />,
            tabBarBadge: t.name === 'inbox' && waiting > 0 ? waiting : undefined,
            tabBarAccessibilityLabel: t.name === 'inbox' && waiting > 0 ? `${t.title}, ${waiting} waiting` : t.title,
          }}
        />
      ))}
    </Tabs>
  );
}
