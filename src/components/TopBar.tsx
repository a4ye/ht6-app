import React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { C, F } from '../theme';
import OutlinedText from './OutlinedText';
import { BTN_CREAM, ICONS, NineSliceBg } from './PixelUI';
import { useNav } from '../state/nav';

// Screen header: sprite Close button top-left, chunky pixel title.
export default function TopBar({ title }: { title: string }) {
  const nav = useNav();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 10,
      }}
    >
      <Pressable onPress={nav.back} hitSlop={8}>
        <View
          style={{
            width: 60,
            height: 60,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <NineSliceBg set={BTN_CREAM} corner={12} />
          <Image source={ICONS.x} style={{ width: 22, height: 22 }} />
          <Text
            allowFontScaling={false}
            style={{ fontFamily: F.display, fontSize: 9, color: C.brown, includeFontPadding: false, marginTop: 2 }}
          >
            Close
          </Text>
        </View>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
        <OutlinedText size={26} color={C.white} outline={C.darkInk} thickness={2.5}>
          {title}
        </OutlinedText>
      </View>
      <View style={{ width: 60 }} />
    </View>
  );
}
