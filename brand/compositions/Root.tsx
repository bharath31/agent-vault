// Remotion root for nominee's brand assets. Render from a Remotion project that
// has these files on its module path (see ../README.md for the render flow):
//   npx remotion still  Banner ../.github/media/banner.png
//   npx remotion still  Og     ../site/assets/og.png
//   npx remotion render Proof  ../site/assets/nominee-proof.mp4
import { Composition, Still } from 'remotion'
import { Banner } from './Banner'
import { Og } from './Og'
import { Proof } from './Proof'

export const RemotionRoot = () => {
  return (
    <>
      <Still id="Banner" component={Banner} width={1600} height={520} />
      <Still id="Og" component={Og} width={1200} height={630} />
      <Composition
        id="Proof"
        component={Proof}
        durationInFrames={240}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  )
}
