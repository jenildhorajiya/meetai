import { useState } from "react";
import { StreamTheme, useCall } from "@stream-io/video-react-sdk";
import { toast } from "sonner";
import { CallLobby } from "./call-lobby";
import { CallActive } from "./call-active";
import { CallEnded } from "./call-ended";

interface Props {
  meetingName: string;
}

export const CallUI = ({ meetingName }: Props) => {
  const call = useCall();
  const [show, setShow] = useState<"lobby" | "call" | "ended">("lobby");
  const [joining, setJoining] = useState(false);

  const handleJoin = async () => {
    if (!call || joining) return;

    setJoining(true);
    try {
      await call.join();
      setShow("call");
    } catch (error) {
      console.error("Failed to join meeting", error);
      toast.error("Couldn't join the meeting. Try again.");
    } finally {
      setJoining(false);
    }
  };

  return (
    <StreamTheme className="h-full">
      {show === "lobby" && <CallLobby onJoin={handleJoin} joining={joining} />}
      {show === "call" && <CallActive onLeave={() => setShow("ended")} meetingName={meetingName} />}
      {show === "ended" && <CallEnded />}
    </StreamTheme>
  );
};
