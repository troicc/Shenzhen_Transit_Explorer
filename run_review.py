import uvicorn


if __name__ == "__main__":
    # 故意固定为回环地址；内部完整数据不得监听 0.0.0.0。
    uvicorn.run("zhanyue.review_server:app", host="127.0.0.1", port=8011, reload=False)
