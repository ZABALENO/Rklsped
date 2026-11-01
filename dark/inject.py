import re,sys,os
root=os.path.dirname(os.path.abspath(__file__))
css=open(root+'/dark.css').read();js=open(root+'/dark.js').read()

for f in ['public/index.html','public-doprava/index.html']:
    p=os.path.join(root,'..',f);s=open(p).read()
    s=re.sub(r'<!--DARK-->.*?<!--/DARK-->','',s,flags=re.S)
    blk='<!--DARK--><style id="darkcss">\n'+css+'</style><script>'+js+'</script><!--/DARK-->'
    s=s.replace('</style>\n</head>','</style>\n'+blk+'\n</head>',1) if '</style>\n</head>' in s else s.replace('</head>',blk+'</head>',1)
    s=re.sub(r'<!--DARKJS-->.*?<!--/DARKJS-->','',s,flags=re.S)
    open(p,'w').write(s);print('ok',f)
