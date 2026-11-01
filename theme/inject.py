import re,os
root=os.path.dirname(os.path.abspath(__file__))
css=open(root+'/light.css').read();js=open(root+'/theme.js').read()
js=re.sub(r'/\*.*?\*/','',js);js=re.sub(r'\n\s*','',js)
blk='<!--THEME--><style id="lightcss">'+css+'</style><script>'+js+'</script><!--/THEME-->'
assert '`' not in blk and '${' not in blk and '\\' not in blk
for f,anchor in [('rozcestnik/index.html','</head>'),('lib/auth.js','</head><body>')]:
    p=os.path.join(root,'..',f);t=open(p).read()
    t=re.sub(r'<!--THEME-->.*?<!--/THEME-->','',t,flags=re.S)
    assert anchor in t
    t=t.replace(anchor,blk+anchor,1);open(p,'w').write(t);print('ok',f)
