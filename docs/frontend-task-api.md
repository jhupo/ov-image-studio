# Frontend Task API

This document describes the browser-facing API exposed by the 31 host. The
frontend should call the 31 host only; the 31 worker calls the upstream image API
and the 68 upscaler service internally.

Examples below use:

```text
BASE_URL=http://192.168.2.31
```

Use the page origin instead when the frontend is served from the same host.

## Flow

1. Create a task with `POST /api/tasks`.
2. Poll `GET /api/tasks/{taskId}` every 2-5 seconds without `includeResult`.
3. Show task state from `status` and `phase`.
4. When `status` is `succeeded`, fetch once more with `includeResult=1`.
5. Store or render `result.images[]`, which are data URLs.

When the upstream image is generated but its real dimensions do not match the
requested dimensions, `phase` changes to `upscaling`. The frontend should keep
polling and show a message such as `图片已生成，正在无损处理`.

## Create Task

`POST /api/tasks`

Headers:

```http
Content-Type: application/json
Idempotency-Key: optional-client-generated-id
```

Body:

```json
{
  "requesterId": "client-user-or-session-id",
  "prompt": "A clean 16:9 product image of a blue ceramic teacup on a white table",
  "params": {
    "size": "3840x2160",
    "quality": "auto",
    "output_format": "png",
    "output_compression": null,
    "moderation": "auto",
    "n": 1
  },
  "profile": {
    "name": "default",
    "provider": "openai",
    "baseUrl": "https://dash.classicriver.cn/v1",
    "imageApiBaseUrl": "https://dash.classicriver.cn/v1",
    "apiKey": "<OPENAI_COMPATIBLE_API_KEY>",
    "model": "gpt-image-1",
    "timeout": 900,
    "apiMode": "images",
    "codexCli": false
  },
  "inputImageDataUrls": []
}
```

Successful response:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "task-id",
    "requesterId": "client-user-or-session-id",
    "status": "queued",
    "phase": "queued",
    "queuePosition": 1,
    "result": null
  }
}
```

Validation notes:

- `profile.provider` must be `openai`.
- `params.output_format` must be `png`, `jpeg`, or `webp`.
- `params.quality` must be `auto`, `low`, `medium`, or `high`.
- `params.moderation` must be `auto` or `low`.
- `params.n` must be between `1` and `16`.
- The backend normalizes the upstream base URL to the deployed 31 setting, so
  callers should still send profile URLs but should not call the upstream directly.

## Poll Task

`GET /api/tasks/{taskId}?requesterId={requesterId}`

Poll this endpoint until `status` is one of:

```text
succeeded | failed | canceled
```

Important response fields:

```json
{
  "id": "task-id",
  "status": "running",
  "phase": "upscaling",
  "queuePosition": null,
  "retryCount": 0,
  "maxRetries": 2,
  "errorCode": null,
  "errorCategory": null,
  "queuedMs": 1234,
  "runningMs": 56789,
  "result": {
    "phase": "upscaling",
    "message": "Image generated; upscaling to requested size",
    "metadata": {
      "imageIndex": 0,
      "sourceSize": "1672x941",
      "targetSize": "3840x2160"
    }
  }
}
```

Display recommendations:

- `status=queued`: show queue position when present.
- `status=running, phase=running`: show generating state.
- `status=running, phase=upscaling`: show generated/upscaling state.
- `status=failed`: show `errorCode`, `errorCategory`, and `error`.

## Fetch Result

Only request the image payload after success:

`GET /api/tasks/{taskId}?requesterId={requesterId}&includeResult=1`

Successful result response:

```json
{
  "status": "succeeded",
  "phase": "succeeded",
  "result": {
    "images": [
      "data:image/png;base64,..."
    ],
    "actualParams": {
      "size": "3840x2160",
      "quality": "auto",
      "output_format": "png",
      "n": 1
    },
    "actualParamsList": [
      {
        "size": "3840x2160",
        "quality": "auto",
        "output_format": "png"
      }
    ],
    "revisedPrompts": [],
    "upscale": {
      "processedCount": 1,
      "targetSize": "3840x2160",
      "serviceUrl": "http://192.168.2.68:8790"
    }
  }
}
```

`result.upscale` is present only when 31 had to send the upstream image to 68 for
super-resolution.

## Events

`GET /api/tasks/{taskId}/events?requesterId={requesterId}`

Useful event types:

```text
created
claimed
upstream_request
upscale_request
upscale_started
upscale_succeeded
succeeded
failed
retry_scheduled
cancel_requested
```

The frontend can show these in a detail view. Polling the task endpoint is enough
for the normal generation UI.

## Cancel Task

`POST /api/tasks/{taskId}/cancel?requesterId={requesterId}`

This marks queued/running tasks as canceled and asks the worker to stop the
upstream request when possible.

## Retry Task

`POST /api/tasks/{taskId}/retry?requesterId={requesterId}`

Only failed or canceled tasks can be retried, and only while the original payload
is still available.

## Browser Example

```ts
const baseUrl = 'http://192.168.2.31'
const requesterId = crypto.randomUUID()

const createResponse = await fetch(`${baseUrl}/api/tasks`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    requesterId,
    prompt: 'A clean 16:9 product image of a blue ceramic teacup on a white table',
    params: {
      size: '3840x2160',
      quality: 'auto',
      output_format: 'png',
      output_compression: null,
      moderation: 'auto',
      n: 1,
    },
    profile: {
      name: 'default',
      provider: 'openai',
      baseUrl: 'https://dash.classicriver.cn/v1',
      imageApiBaseUrl: 'https://dash.classicriver.cn/v1',
      apiKey: '<OPENAI_COMPATIBLE_API_KEY>',
      model: 'gpt-image-1',
      timeout: 900,
      apiMode: 'images',
      codexCli: false,
    },
    inputImageDataUrls: [],
  }),
})

const created = (await createResponse.json()).data
let task = created

while (!['succeeded', 'failed', 'canceled'].includes(task.status)) {
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const pollResponse = await fetch(
    `${baseUrl}/api/tasks/${encodeURIComponent(created.id)}?` +
      new URLSearchParams({ requesterId }),
  )
  task = (await pollResponse.json()).data
}

if (task.status === 'succeeded') {
  const resultResponse = await fetch(
    `${baseUrl}/api/tasks/${encodeURIComponent(created.id)}?` +
      new URLSearchParams({ requesterId, includeResult: '1' }),
  )
  task = (await resultResponse.json()).data
  const images = task.result.images
}
```
