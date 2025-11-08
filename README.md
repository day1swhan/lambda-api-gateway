# @day1swhan/lambda-api-gateway

## Overview

**AWS Lambda에 최적화된 Express.js 스타일의 초경량 마이크로 프레임워크**

Lambda URL 하나로 나만의 API Gateway를 직접 구성할 수 있습니다.

```ts
import { LambdaAPIGateway } from "@day1swhan/lambda-api-gateway";

const app = new LambdaAPIGateway({ extended: true });

app.get("/", (event, context) => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ message: "Hello World!" }),
  };
});

export const handler = app.export().handler;
```

## Features

- **초경량** – 단일 파일(`router.ts`)로 구성된 미니멀 구조
- **미들웨어 지원** – 체이닝 가능한 함수형 미들웨어로 요청 흐름 제어
- **자동 파싱** – 쿼리스트링, 쿠키를 기본 파싱하여 바로 사용 가능

## Install

```sh
npm install @day1swhan/lambda-api-gateway
npm install -D @types/aws-lambda # dev
```

## Middleware

미들웨어 함수는 **전역 미들웨어** → **라우터 미들웨어** → **최종 핸들러** 순으로 실행됩니다.

`next` 함수를 이용해서 다음 미들웨어를 호출할 수 있으며, 동기 & 비동기 함수 모두 지원합니다.

`prefix` 기반으로 미들웨어 호출 여부를 제어할 수 있고, prefix 없이 호출된 미들웨어는 전역 미들웨어("/")로 작동합니다.

```ts
import { LambdaAPIGateway, Middleware } from "@day1swhan/lambda-api-gateway";

const app = new LambdaAPIGateway({ extended: true });

const middlewareA: Middleware = (next) => (event, context) => {
  console.log("middlewareA");
  return next(event, context);
};

const middlewareB: Middleware = (next) => async (event, context) => {
  console.log("middlewareB");
  return next(event, context);
};

app.use("/", middlewareA);
app.use("/", middlewareB);

app.get("/", (event, context) => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ message: "Hello World!" }),
  };
});

export const handler = app.export().handler;
```

```sh
curl -i https://xxxx.lambda-url.<AWS_REGION>.on.aws

HTTP/1.1 200 OK
...
{"message":"Hello World"}
```

```sh
# console.log
middlewareA
middlewareB
finalHandler
```
