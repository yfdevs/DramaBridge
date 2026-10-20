# @dramabridge/axios

轻量 axios 封装，提供语义化客户端和常用拦截器。

## 使用

```ts
import {
  ApiClient,
  attachAuthTokenHeader,
  unwrapApiResponseData,
  handleApiResponseError,
} from "@dramabridge/axios";

interface UserProfile {
  id: string;
  name: string;
}

const http = new ApiClient({
  baseURL: "/api",
});

http.addRequestInterceptor((config) => attachAuthTokenHeader(config, "access_token"));
http.addResponseInterceptor(unwrapApiResponseData, handleApiResponseError);

const profile = await http.get<UserProfile>("/profile");
```

## 核心导出

- `ApiClient`：封装 axios，请求直接返回 `response.data`
- `attachAuthTokenHeader`：从 `localStorage` 注入 `Authorization`
- `unwrapApiResponseData`：解包通用响应结构
- `handleApiResponseError`：统一响应错误处理
- `ApiResponseEnvelope<T>`：标准响应类型

## 本地开发

```bash
vp install
vp run test --filter @dramabridge/axios
vp check packages/axios
```
