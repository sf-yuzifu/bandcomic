import { dict } from "./dic.js";

const SimpleInputMethod = {
  dict: {},
};

SimpleInputMethod.initDict = function () {
  this.dict.py2hz = dict;
  this.dict.py2hz2 = {};
  this.dict.py2hz2["i"] = "i"; // i比较特殊，没有符合的汉字，所以特殊处理

  for (const key in this.dict.py2hz) {
    const ch = key[0];
    if (!this.dict.py2hz2[ch]) {
      this.dict.py2hz2[ch] = this.dict.py2hz[key];
    }
  }
};

SimpleInputMethod.getSingleHanzi = function (pinyin) {
  return this.dict.py2hz2[pinyin] || this.dict.py2hz[pinyin] || "";
};

SimpleInputMethod.getHanzi = function (pinyin) {
  const result = this.getSingleHanzi(pinyin);
  if (result) return [result.split(""), pinyin];

  const temp = "";
  const start = Math.min(pinyin.length, 6);

  for (let i = start; i >= 1; i--) {
    const str = pinyin.substr(0, i);
    const rs = this.getSingleHanzi(str);
    if (rs) return [rs.split(""), str];
  }

  return [[], ""]; // 理论上一般不会出现这种情况
};

SimpleInputMethod.initDict();

export { SimpleInputMethod }; //换成export default SimpleInputMethod;不能用
