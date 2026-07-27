import { config } from "~/lib/config";
import { readState } from "~/lib/store";

export async function GET() {
  const state = await readState();
  return Response.json({
    ...state,
    llm: {
      baseURL: config.lmStudioBaseURL,
      model: config.lmStudioModel,
    },
  });
}
