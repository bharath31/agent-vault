import { loadFont as loadGeist } from '@remotion/google-fonts/Geist'
import { loadFont as loadGeistMono } from '@remotion/google-fonts/GeistMono'
import { loadFont as loadSchibsted } from '@remotion/google-fonts/SchibstedGrotesk'

export const display = loadSchibsted('normal', { weights: ['600', '700'] }).fontFamily
export const sans = loadGeist('normal', { weights: ['400', '500'] }).fontFamily
export const mono = loadGeistMono('normal', { weights: ['400', '500'] }).fontFamily
