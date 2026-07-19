import { NativeModules, Platform } from 'react-native';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';

// Custom AID registered in the HCE service (see android/app/src/main/res/xml/apduservice.xml).
const AID = 'F0544F4D4F31';

type HceModule = {
  setPayload: (payload: string) => Promise<void>;
  clear: () => Promise<void>;
  lastTapAt: () => Promise<number>;
};

const TomoHce: HceModule | undefined = NativeModules.TomoHce;

export function hceAvailable(): boolean {
  return Platform.OS === 'android' && !!TomoHce;
}

// supported = hardware exists; enabled = the NFC toggle is actually on
export async function nfcState(): Promise<{ supported: boolean; enabled: boolean }> {
  try {
    if (Platform.OS !== 'android') return { supported: false, enabled: false };
    const supported = await NfcManager.isSupported();
    const enabled = supported ? await NfcManager.isEnabled() : false;
    return { supported, enabled };
  } catch {
    return { supported: false, enabled: false };
  }
}

export async function nfcAvailable(): Promise<boolean> {
  const s = await nfcState();
  return s.supported;
}

// Timestamp (ms) of the last time another phone touched ours while showing.
export async function lastTapAt(): Promise<number> {
  try {
    return (await TomoHce?.lastTapAt()) ?? 0;
  } catch {
    return 0;
  }
}

// "Show" side: additionally act as an NFC tag when the hardware allows it.
// The QR code is always shown; NFC is a bonus transport. Returns whether NFC is on.
export async function startShowing(payload: string): Promise<boolean> {
  if (!TomoHce || !(await nfcAvailable())) return false;
  try {
    await TomoHce.setPayload(payload);
    return true;
  } catch {
    return false;
  }
}

export async function stopShowing(): Promise<void> {
  await TomoHce?.clear();
}

function toBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export async function cancelScan(): Promise<void> {
  await NfcManager.cancelTechnologyRequest().catch(() => {});
}

// "Scan" side: read the other phone once over NFC. Resolves with its payload string.
export async function scanOnce(): Promise<string> {
  await NfcManager.start();
  await NfcManager.cancelTechnologyRequest().catch(() => {});
  try {
    await NfcManager.requestTechnology(NfcTech.IsoDep, {
      alertMessage: 'Touch the phones back to back',
    });
    const select = [0x00, 0xa4, 0x04, 0x00, AID.length / 2, ...toBytes(AID), 0x00];
    const resp: number[] = await NfcManager.isoDepHandler.transceive(select);
    if (resp.length < 2) throw new Error('Empty response');
    const sw = (resp[resp.length - 2] << 8) | resp[resp.length - 1];
    if (sw !== 0x9000) throw new Error('The other phone is not showing a code right now');
    const data = resp.slice(0, -2);
    return String.fromCharCode(...data);
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}
