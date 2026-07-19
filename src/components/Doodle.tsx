import React, { useRef, useState } from 'react';
import { Animated, Pressable, Text, View, ViewStyle } from 'react-native';
import { C, F } from '../theme';
import {
  BTN_CREAM, BTN_CREAM_PRESSED, BTN_TAN, BTN_TAN_PRESSED,
  NineSliceBg, PANEL_CREAM, PANEL_TAN,
} from './PixelUI';

// ---- DoodleCard: Sprout Lands 9-slice panel ----
// bg other than the default cream renders on the tan "highlight" panel.
export function DoodleCard({
  children,
  seed: _seed = 1,
  tilt: _tilt = 0,
  bg = C.cream,
  border: _border = C.brown,
  style,
}: {
  children?: React.ReactNode;
  seed?: number;
  tilt?: number;
  bg?: string;
  border?: string;
  style?: ViewStyle | ViewStyle[];
}) {
  const set = bg === C.cream ? PANEL_CREAM : PANEL_TAN;
  return (
    <View style={[{ padding: 16, minHeight: 34 }, style as ViewStyle]}>
      <NineSliceBg set={set} corner={15} />
      {children}
    </View>
  );
}

// ---- DoodleButton: Sprout Lands sprite button with a pressed state ----
export function DoodleButton({
  label,
  icon: _icon,
  onPress,
  seed: _seed = 7,
  bg = C.white,
  border: _border = C.orange,
  color = C.brown,
  size = 15,
  disabled = false,
  style,
}: {
  label: string;
  icon?: string;
  onPress?: () => void;
  seed?: number;
  bg?: string;
  border?: string;
  color?: string;
  size?: number;
  disabled?: boolean;
  style?: ViewStyle | ViewStyle[];
}) {
  const [pressed, setPressed] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const springTo = (v: number) =>
    Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 10 }).start();
  const primary = bg === C.yellow;
  const set = primary
    ? pressed ? BTN_TAN_PRESSED : BTN_TAN
    : pressed ? BTN_CREAM_PRESSED : BTN_CREAM;
  return (
    <Pressable
      disabled={disabled}
      onPressIn={() => {
        setPressed(true);
        springTo(0.95);
      }}
      onPressOut={() => {
        setPressed(false);
        springTo(1);
      }}
      onPress={onPress}
    >
      <Animated.View
        style={[
          {
            paddingVertical: 11,
            paddingHorizontal: 18,
            minHeight: 40,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disabled ? 0.45 : 1,
            transform: [{ scale }],
          },
          style as ViewStyle,
        ]}
      >
        <NineSliceBg set={set} corner={12} />
        <Text
          allowFontScaling={false}
          style={{
            fontFamily: F.display,
            fontSize: size,
            color: disabled ? C.fadedInk : color,
            includeFontPadding: false,
            marginTop: pressed ? 2 : 0,
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

// ---- Small pill (stat fields) ----
export function StatPill({
  children,
  borderColor = '#C89A62',
  style,
}: {
  children: React.ReactNode;
  borderColor?: string;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          backgroundColor: C.white,
          borderWidth: 2.5,
          borderColor,
          borderRadius: 6,
          paddingVertical: 6,
          paddingHorizontal: 12,
          minHeight: 34,
          justifyContent: 'center',
        },
        style,
      ]}
    >
      {typeof children === 'string' ? (
        <Text
          allowFontScaling={false}
          style={{ fontFamily: F.body, fontSize: 15, color: C.darkInk, includeFontPadding: false }}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}
