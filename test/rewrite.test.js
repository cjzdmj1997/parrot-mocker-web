'use strict';

const fetch = require('node-fetch');
const request = require('supertest');
const koa = require('koa');
const kcors = require('kcors');
const fetchMiddleware = require('../server/fetch.js');
const updateconfig = require('../server/api/updateconfig.js');
const rewrite = require('../server/api/rewrite.js');
const {KEY_CLIENT_ID, generateCookieItem} = require('../common/cookie.js');
const Message = require('../common/message.js');

const RETRY_LIMIT = 3;
const pureHost = 'parrotmocker.leanapp.cn';
const host = 'https://' + pureHost;

function prepareMiddlewares(app) {
    app.use(fetchMiddleware);
    app.use(kcors({
        credentials: true
    }));
    app.use(function*(next) {
        const path = this.path;
        if (path === '/api/updateconfig') {
            yield* updateconfig.call(this, next);
        } else if (path === '/api/rewrite'){
            yield* rewrite.call(this, next);
        }
    });
}
function prepareSocketIO(app) {
    const socket = {
        emit: jest.fn()
    };
    const io = {
        sockets: {
            in: jest.fn().mockReturnValue(socket)
        }
    };

    app.io = io;
    app.mockSocket = socket; // for testing
}

function wakeupTestServer(retry) {
    console.log(`wakeupTestServer: retry=${retry}`);

    return fetch(host + '/api/test')
        .catch(() => {
            if (retry) return wakeupTestServer(retry - 1);
        });
}
function setMockConfig(app, clientId, jsonstr) {
    return request(app.callback())
        .post('/api/updateconfig')
        .set('cookie', generateCookieItem(KEY_CLIENT_ID, clientId))
        .send({
            jsonstr
        })
        .expect((res) => {
            expect(res.body.code).toEqual(200);
        });
}

describe('/api/rewrite', () => {
    let app;

    beforeAll(() => {
        app = koa();
        prepareMiddlewares(app);
        prepareSocketIO(app);

        jest.setTimeout(RETRY_LIMIT * 5000);
        return wakeupTestServer(RETRY_LIMIT);
    });
    beforeEach(() => {
        app.mockSocket.emit.mockClear();
    });
    describe('forward', () => {
        it('should ignore if no client id', () => {
            return request(app.callback())
                .get('/api/rewrite')
                .expect('no clientID, ignored');
        });
        it('should forward GET request', async () => {
            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/test',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect('I am running!');

            expect(app.mockSocket.emit).toHaveBeenCalledTimes(2);
            expect(app.mockSocket.emit).nthCalledWith(1, Message.MSG_REQUEST_START, expect.objectContaining({
                isMock: false,
                method: 'GET',
                host: pureHost,
                pathname: '/api/test',
                url: host + '/api/test'
            }));
            expect(app.mockSocket.emit).nthCalledWith(2, Message.MSG_REQUEST_END, expect.objectContaining({
                status: 200,
                requestData: 'not POST request',
                responseBody: 'I am running!'
            }));
        });
        it('should forward POST request', async () => {
            const postData = {
                a: 1,
                b: 2
            };
            const responseBody = await request(app.callback())
                .post('/api/rewrite')
                .query({
                    url: host + '/api/testxhr',
                    cookie: [
                        generateCookieItem('testkey', 'testvalue'),
                        generateCookieItem(KEY_CLIENT_ID, 'clientid')
                    ].join('; ')
                })
                .set('origin', 'fakeorigin.com')
                .send(postData)
                .expect((res) => {
                    expect(res.headers['access-control-allow-origin']).toEqual('fakeorigin.com');
                    expect(res.headers['access-control-allow-credentials']).toEqual('true');

                    expect(res.body.data.requestData).toEqual(postData);
                })
                .then((res) => res.body);

            expect(app.mockSocket.emit).toHaveBeenCalledTimes(2);
            expect(app.mockSocket.emit).nthCalledWith(1, Message.MSG_REQUEST_START, expect.objectContaining({
                isMock: false,
                method: 'POST',
                host: 'parrotmocker.leanapp.cn',
                pathname: '/api/testxhr',
                url: host + '/api/testxhr'
            }));
            expect(app.mockSocket.emit).nthCalledWith(2, Message.MSG_REQUEST_END, expect.objectContaining({
                status: 200,
                requestData: postData,
                responseBody
            }));

            const cookies = responseBody.data.requestHeaders.cookie;
            expect(cookies).toEqual(generateCookieItem('testkey', 'testvalue'));
        });
        it('should forward jsonp request', async () => {
            const expectedData = {
                code: 200,
                msg: 'good jsonp'
            };
            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/testjsonp?callback=jsonp_cb',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid'),
                    reqtype: 'jsonp'
                })
                .expect(`jsonp_cb(${JSON.stringify(expectedData)})`);

            expect(app.mockSocket.emit).toHaveBeenCalledTimes(2);
            expect(app.mockSocket.emit).nthCalledWith(1, Message.MSG_REQUEST_START, expect.objectContaining({
                isMock: false,
                method: 'GET',
                host: 'parrotmocker.leanapp.cn',
                pathname: '/api/testjsonp',
                url: host + '/api/testjsonp?callback=jsonp_cb'
            }));
            expect(app.mockSocket.emit).nthCalledWith(2, Message.MSG_REQUEST_END, expect.objectContaining({
                status: 200,
                requestData: 'not POST request',
                responseBody: expectedData
            }));
        });
    });
    describe('mock', () => {
        it('should mock if matched by `path`', async () => {
            await setMockConfig(app, 'clientid', `[{
                "path": "/api/nonexist",
                "status": 200,
                "response": {
                    "code": 200,
                    "msg": "mock response"
                }
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/nonexist',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect((res) => {
                    expect(res.body).toEqual({
                        "code": 200,
                        "msg": "mock response"
                    });
                });
        });
        it('should mock if matched by `path` and `responsetype=mockjs`', async () => {
            await setMockConfig(app, 'clientid', `[{
                "path": "/api/nonexist",
                "status": 200,
                "responsetype": "mockjs",
                "response": {
                    "code": 200,
                    "msg|3": ["mock response"]
                }
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/nonexist',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect((res) => {
                    expect(res.body).toEqual({
                        "code": 200,
                        "msg": Array(3).fill("mock response")
                    });
                });
        });
        it('should mock if matched by `path` and `pathtype=regexp`', async () => {
            await setMockConfig(app, 'clientid', `[{
                "path": "(bad)?nonexist",
                "pathtype": "regexp",
                "status": 200,
                "response": {
                    "code": 200,
                    "msg": "mock response"
                }
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/nonexist',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect((res) => {
                    expect(res.body).toEqual({
                        "code": 200,
                        "msg": "mock response"
                    });
                });
        });
        it('should mock when `host` is set', async () => {
            await setMockConfig(app, 'clientid', `[{
                "host": "${pureHost}",
                "path": "/api/test"
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: 'https://bad.com/api/test',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect('I am running!');
        });
        it('should mock when `prepath` is set', async () => {
            await setMockConfig(app, 'clientid', `[{
                "host": "${pureHost}",
                "path": "/test",
                "prepath": "/api"
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/test',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect('I am running!');
        });
        it('should mock when `params` is set', async () => {
            await setMockConfig(app, 'clientid', `[{
                "path": "/api/test",
                "params": "a=1&b=2",
                "status": 200,
                "response": "I am mocking"
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/test?a=1',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect('I am running!');

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/test?a=1&b=2',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect('I am mocking');

            await request(app.callback())
                .post('/api/rewrite')
                .query({
                    url: host + '/api/test',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .send({
                    a: '1',
                    b: '2'
                })
                .expect('I am mocking');
        });
        it('should mock when `status` is set', async () => {
            await setMockConfig(app, 'clientid', `[{
                "path": "/api/nonexist",
                "status": 501,
                "response": {
                    "code": 200,
                    "msg": "mock response"
                }
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/nonexist',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect(501);
        });
        it('should mock when `delay` is set', async () => {
            await setMockConfig(app, 'clientid', `[{
                "delay": 3000,
                "path": "/api/nonexist",
                "status": 200,
                "response": {
                    "code": 200,
                    "msg": "mock response"
                }
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/nonexist',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid')
                })
                .expect((res) => {
                    expect(res.body).toEqual({
                        "code": 200,
                        "msg": "mock response"
                    });
                });

            const timecost = app.mockSocket.emit.mock.calls[1][1].timecost;
            expect(Math.floor(timecost / 1000)).toEqual(3);
        });
        it('should handle big data', async () => {
        });
        it('should handle redirecting', async () => {
        });
        it('should handle complex jsonp content', async () => {
            const expectedData = JSON.stringify({
                code: 200,
                msg: '(a(b)c)'
            });
            await setMockConfig(app, 'clientid', `[{
                "path": "/api/nonexist",
                "status": 200,
                "response": ${expectedData}
            }]`);

            await request(app.callback())
                .get('/api/rewrite')
                .query({
                    url: host + '/api/nonexist?callback=jsonp_cb',
                    cookie: generateCookieItem(KEY_CLIENT_ID, 'clientid'),
                    reqtype: 'jsonp'
                })
                .expect(`jsonp_cb(${expectedData})`);
        });
    });
});
describe('/api/updateconfig', () => {
    let app;

    beforeAll(() => {
        app = koa();
        prepareMiddlewares(app);
        prepareSocketIO(app);
    });
    it('should ingore if no client id', () => {
        return request(app.callback())
            .post('/api/updateconfig')
            .expect((res) => {
                expect(res.body).toMatchObject({
                    code: 500
                });
            });
    });
    it('should throw an error if not array', () => {
        return request(app.callback())
            .post('/api/updateconfig')
            .set('cookie', generateCookieItem(KEY_CLIENT_ID, 'clientid'))
            .send({
                jsonstr: 'no array str'
            })
            .expect((res) => {
                expect(res.body).toMatchObject({
                    code: 500
                });
            });
    });
});
