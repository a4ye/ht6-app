import React from 'react';
import { Text, TextStyle, View, ViewStyle } from 'react-native';
import { C, F } from '../theme';

type Props = {
  children: React.ReactNode;
  size?: number;
  color?: string;
  outline?: string;
  font?: string;
  thickness?: number;
  style?: ViewStyle;
  textAlign?: TextStyle['textAlign'];
};

// Pixel-style heading: a single chunky drop-shadow copy behind the fill,
// like the Sprout Lands UI lettering.
export default function OutlinedText({
  children,
  size = 26,
  color = C.white,
  outline = C.darkInk,
  font = F.display,
  thickness = 2,
  style,
  textAlign,
}: Props) {
  const off = Math.max(2, Math.round(thickness * 1.2));
  const base: TextStyle = {
    fontFamily: font,
    fontSize: size,
    lineHeight: size * 1.35,
    textAlign,
    includeFontPadding: false,
  };
  return (
    <View style={style}>
      <Text
        allowFontScaling={false}
        style={[base, { color: outline, position: 'absolute', left: off, top: off, right: -off }]}
      >
        {children}
      </Text>
      <Text allowFontScaling={false} style={[base, { color }]}>
        {children}
      </Text>
    </View>
  );
}
