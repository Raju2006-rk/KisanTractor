import { forwardMapOperation } from "../../../../lib/maps-api-proxy";

export const POST = (request: Request) => forwardMapOperation(request, "map-pin");
