let A=0x67452301,B=0xefcdab89,C=0x98badcfe,D=0x10325476;
const rotl=(x,s)=>{x=x>>>0;return ((x<<s)|(x>>>(32-s)))>>>0;};
const F=(x,y,z)=>((x&y)|(~x&z))>>>0;
const G=(x,y,z)=>((x&y)|(x&z)|(y&z))>>>0;
const H=(x,y,z)=>(x^y^z)>>>0;
const X=new Array(16).fill(0);X[0]=0x80;
let a=A,b=B,c=C,d=D;
for(let i=0;i<16;i++){a=rotl(a+F(b,c,d)+X[i],[3,7,11,19][i%4]);[a,b,c,d]=[d,a,b,c];}
console.log('after R1 a,b,c,d=',a.toString(16),b.toString(16),c.toString(16),d.toString(16));
const r2o=[0,4,8,12,1,5,9,13,2,6,10,14,3,7,11,15],r2s=[3,5,9,13];
for(let i=0;i<16;i++){a=rotl(a+G(b,c,d)+X[r2o[i]]+0x5a827999,r2s[i%4]);[a,b,c,d]=[d,a,b,c];}
console.log('after R2 a,b,c,d=',a.toString(16),b.toString(16),c.toString(16),d.toString(16));
const r3o=[0,8,4,12,2,10,6,14,1,9,5,13,3,11,7,15],r3s=[3,9,11,15];
for(let i=0;i<16;i++){a=rotl(a+H(b,c,d)+X[r3o[i]]+0x6d9d6122,r3s[i%4]);[a,b,c,d]=[d,a,b,c];}
A=(A+a)>>>0;B=(B+b)>>>0;C=(C+c)>>>0;D=(D+d)>>>0;
const out=Buffer.alloc(16);out.writeUInt32LE(A,0);out.writeUInt32LE(B,4);out.writeUInt32LE(C,8);out.writeUInt32LE(D,12);
console.log('MD4(empty) =',out.toString('hex'),'expect 31d6cfe0d16ae931b73c59d7e0c089c0');
