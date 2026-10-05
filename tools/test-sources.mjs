import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { createSourceFixtureContext, sourceFixture } from "./source-test-fixture.mjs";
const source = fs.readFileSync(new URL("../src/components/sourceConfig.js",import.meta.url),"utf8");
const helpers = vm.createContext({});
vm.runInContext(source.replace(/^export /gm,"")+"\nglobalThis.api={isComicId,validateSourceConfig,validSourceDirectory};",helpers);

test("sources: eight backend keys retain their IDs and validate complete source contracts",()=>{
  const {isComicId,validateSourceConfig}=helpers.api;
  const cases=[["JMComic","jmcomic","123"],["BilibiliManga","bilibili","123"],["QQComic","qqcomic","123"],
    ["KuaikanComic","kuaikan","123"],["MangaDex","mangadex","11111111-1111-1111-1111-111111111111"],
    ["CopyManga","copymanga","comic_slug"],["E-Hentai","ehentai","123_abcdef1234"],["copy_manga","venera","comic_slug"]];
  for(const [key,type,id] of cases){
    assert.equal(validateSourceConfig(key,sourceFixture({type})),"");
    assert.equal(isComicId(id,{type},key),true,key);
    assert.equal(isComicId("中文关键词",{type},key),false,key);
  }
  const invalid=[sourceFixture({apiUrl:"javascript:bad"}),sourceFixture({detailPath:"//evil/<id>"}),
    sourceFixture({photoPath:"/photo/<wrong>"}),sourceFixture({searchPath:"/search/<text>"}),
    sourceFixture({idType:"unknown"})];
  for(const config of invalid) assert.notEqual(validateSourceConfig("A",config),"");
  assert.notEqual(validateSourceConfig("using",sourceFixture()),"");
  assert.equal(validateSourceConfig("A",sourceFixture({apiUrl:"https://host.test/prefix"})),"");
});

function harness(){
  const calls=[];
  const global={userAgent:()=>"UA",API_SETTING:{using:"A",A:sourceFixture({apiUrl:"https://a.test"}),B:sourceFixture({apiUrl:"https://b.test"})},cookie:{A:"a=private",B:"b=private"}};
  const context=createSourceFixtureContext({global,Promise,setTimeout,clearTimeout,Date,
    safeJsonParse:(value)=>typeof value==="string"?JSON.parse(value):value,
    deleteImageTemp:()=>{},appendCoverSuffix:(url)=>url,
    fetch:{fetch(options){calls.push(options);return {cancel(){}}},isDirectAvailable:()=>Promise.resolve(false)}});
  const code=fs.readFileSync(new URL("../src/components/api.js",import.meta.url),"utf8")
    .replace(/^import .*;\r?\n/gm,"").replace(/^export \{[^\n]*\n/gm,"").replace(/^export /gm,"");
  vm.runInContext(code+"\nglobalThis.api={captureSource,saveSourceContext,getSourceContext,apiFetch,checkSourceHealth,buildDetailUrl,formatApiError};",context);
  return {global,calls,api:context.api};
}
test("sources: detail/reading/download preserve configuration and cookie after source sync",()=>{
  const h=harness(),snapshot=h.api.captureSource(),token=h.api.saveSourceContext(snapshot);
  h.global.API_SETTING.using="B";h.global.API_SETTING.A.apiUrl="https://changed.test";h.global.cookie.A="changed";
  const fixed=h.api.getSourceContext(token);
  h.api.apiFetch({url:h.api.buildDetailUrl("a/b",fixed.source),sourceContext:fixed});
  assert.equal(h.calls[0].url,"https://a.test/album/a%2Fb");
  assert.equal(h.calls[0].header.Cookie,"a=private");
  assert.equal(h.global.API_SETTING.using,"B");
});
test("sources: health requires the requested entry and config import never sends active cookie",async()=>{
  const h=harness();
  const health=h.api.checkSourceHealth("B");
  assert.equal(h.calls[0].header.Cookie,undefined);
  h.calls[0].success({code:200,data:JSON.stringify({A:sourceFixture()})});
  assert.equal((await health).status,"invalid");
  h.api.apiFetch({url:"https://new.test/config",anonymous:true});
  assert.equal(h.calls[1].header.Cookie,undefined);
});
test("sources: Retry-After cools the source across pages instead of repeated upstream calls",async()=>{
  const h=harness();let error;
  const options={url:"https://a.test/image",sourceContext:h.api.captureSource(),fail:(message,code)=>{error={message,code}}};
  h.api.apiFetch(options);
  h.calls[0].success({code:429,header:{"Retry-After":"40"},data:{message:"limited"}});
  assert.equal(error.code,429);assert.match(error.message,/40s/);
  h.api.apiFetch(options);await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(h.calls.length,1);assert.equal(error.code,429);
});

test("sources: formatApiError extracts rich diagnostic info across all statuses, codes and messages",()=>{
  const h=harness();
  const format=h.api.formatApiError;
  // 模拟页面多语言注入函数
  const mockT=(key,params)=>{
    const dict={
      "error.http.403":"访问受限(付费章节/Cookie失效)",
      "error.http.429":"访问频繁触发限流",
      "error.curl.28":"网络请求超时(curl 28)",
      "error.curl.35":"SSL握手失败(建议开启网桥)",
      "error.curl.6":"域名解析失败(DNS异常)",
      "error.curl.7":"无法连接服务器(端口被拒/网络断开)",
      "error.retryAfter":` (请等待${params?.seconds}秒重试)`,
    };
    return dict[key]||key;
  };

  // 1. 带业务 JSON message 的 403
  const e403=format(JSON.stringify({code:403,message:"该章节为付费章节，请在bilibili购买"}),403,{sourceKey:"A",t:mockT});
  assert.equal(e403.statusCode,403);
  assert.equal(e403.formatted,"[Fixture] [403] 该章节为付费章节，请在bilibili购买");

  // 2. 带 Retry-After 的 429
  const e429=format("HTTP 429 (Retry-After 30s)",429,{sourceKey:"B",action:"Search",t:mockT});
  assert.equal(e429.statusCode,429);
  assert.match(e429.formatted,/\[Fixture\] Search \[429\] 访问频繁触发限流.*30秒/);

  // 3. 英文/默认未传 t 时走中立文本
  const eNeutral=format("HTTP 429 (Retry-After 30s)",429,{sourceKey:"B",action:"Search"});
  assert.equal(eNeutral.statusCode,429);
  assert.match(eNeutral.formatted,/\[Fixture\] Search \[429\] Rate limited by source.*wait 30s/);

  // 4. 413 数据过大
  const e413=format(JSON.stringify({message:"Payload too large"}),413,{sourceKey:"A"});
  assert.equal(e413.statusCode,413);
  assert.equal(e413.formatted,"[Fixture] [413] Payload too large");

  // 5. 404
  const e404=format("",404,{sourceKey:"A",t:mockT});
  assert.equal(e404.statusCode,404);
  assert.ok(e404.formatted.includes("404"));

  // 6. 502 / 503
  const e502=format(JSON.stringify({message:"MangaDex upstream error"}),502,{sourceKey:"A"});
  assert.equal(e502.statusCode,502);
  assert.equal(e502.formatted,"[Fixture] [502] MangaDex upstream error");

  // 7. cURL 网络底层错误走多语言
  const eTimeout=format("request timed out",28,{sourceKey:"A",t:mockT});
  assert.equal(eTimeout.curlCode,28);
  assert.match(eTimeout.formatted,/网络请求超时/);

  const eSsl=format("SSL handshake error: 35",35,{sourceKey:"A",t:mockT});
  assert.equal(eSsl.curlCode,35);
  assert.match(eSsl.formatted,/SSL握手失败/);

  const eDns=format("could not resolve host",6,{sourceKey:"A",t:mockT});
  assert.equal(eDns.curlCode,6);
  assert.match(eDns.formatted,/域名解析失败/);

  const eConn=format("connection refused",7,{sourceKey:"A",t:mockT});
  assert.equal(eConn.curlCode,7);
  assert.match(eConn.formatted,/无法连接服务器/);
});
