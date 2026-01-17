import Belief from "~/components/landing/belief"
import HeroManifest from "~/components/landing/hero-manifest"
import MainfestoCopy from "~/components/landing/mainfesto-copy"
import PillarsPriceOps from "~/components/landing/pillarsAMI"

export default function Manifesto() {
  return (
    <main className="flex flex-col overflow-hidden pb-28">
      <HeroManifest />

      <div className="mx-auto flex w-full max-w-4xl flex-col overflow-hidden px-3">
        <MainfestoCopy />
        <PillarsPriceOps />
        <Belief />
      </div>
    </main>
  )
}
