/** 本地应用连通性检查的路径和响应契约。 */
import { z } from "zod";

/** 相对于应用 API 前缀的健康检查路径。 */
export const healthPath = "/health";

/** 健康检查成功只表示 HTTP 服务能够响应。 */
export const healthResponseSchema = z.strictObject({ status: z.literal("ok") });
