import GhostLogo from "@/components/GhostLogo";

export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/svg+xml";

export default function Icon() {
  return <GhostLogo className="h-full w-full" />;
}
