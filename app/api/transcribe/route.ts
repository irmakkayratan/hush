import { readRequestBody, RequestBodyTooLarge } from "@/lib/read-request-body";
import { requireWorkspaceAccess, WorkspaceAccessError } from "@/lib/workspace-access";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
  // Check membership before reading audio or contacting the transcription service.
  try {
    await requireWorkspaceAccess(request, request.headers.get("X-Hush-Workspace-Id") || "");
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return Response.json({ message: error.message }, { status: error.status });
    }
    return Response.json({ message: "Could not verify workspace access." }, { status: 503 });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return Response.json({ message: "Connection settings are missing." }, { status: 500 });
  }

  const recordingTooLarge = () => Response.json(
    { message: "Please use a recording under 10 MB." },
    { status: 413 }
  );

  try {
    let form;
    try {
      form = await readRequestBody(request, MAX_UPLOAD_BYTES).formData();
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) return recordingTooLarge();
      return Response.json({ message: "Could not read the audio upload." }, { status: 400 });
    }
    const file = form.get("file");

    if (!(file instanceof File) || file.size === 0) {
      return Response.json(
        { message: "An audio recording is required." },
        { status: 400 }
      );
    }

    if (file.size > MAX_AUDIO_BYTES) return recordingTooLarge();

    const extension = file.name.split(".").pop()?.toLowerCase();

    if (
      !extension ||
      !["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"].includes(
        extension
      )
    ) {
      return Response.json(
        { message: "Please use a supported audio format." },
        { status: 400 }
      );
    }

    const upload = new FormData();
    upload.append("file", file, file.name);
    upload.append("model", "gpt-transcribe");

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
        },
        body: upload,
        signal: AbortSignal.timeout(90000),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return Response.json(
        {
          message: "Could not transcribe the recording.",
          code: result.error?.code || "transcription_error",
        },
        { status: 502 }
      );
    }

    if (typeof result.text !== "string" || !result.text.trim()) {
      return Response.json(
        { message: "No speech was detected. Please try again." },
        { status: 422 }
      );
    }

    return Response.json({ text: result.text.trim() });
  } catch {
    return Response.json(
      { message: "Could not transcribe the recording. Please try again." },
      { status: 502 }
    );
  }
}
