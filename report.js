import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

export const forms = {
  exhibit: { title:'Exhibit register', fields:{
    description:'Description', type:'Evidence type', location:'Recovery location', time:'Recovered at (GST)',
    recoveredBy:'Recovered by', recoveryMethod:'Recovery method', condition:'Initial condition',
    identifier:'Identifying marks or serial number', packaging:'Packaging type', packageRef:'Package reference',
    seal:'Seal reference', packagedBy:'Packaged and sealed by', initialStorage:'Initial storage',
    mediaRef:'Photo or diagram reference', notes:'Notes'
  }},
  request: { title:'Specialist coordination', fields:{
    specialism:'Unit contacted', person:'Person contacted', time:'Contact time', description:'Purpose of contact',
    advice:'Advice or instructions received', followup:'Agreed follow-up'
  }},
  transfer: { title:'Custody history', fields:{
    from:'Released by', to:'Received by', origin:'Origin', destination:'Destination', time:'Transfer time (GST)',
    purpose:'Purpose of transfer', sealCondition:'Seal condition', ack:'Receiver acknowledgement', notes:'Notes or exceptions'
  }},
  video: { title:'Recording and storage log', fields:{
    description:'Recording title', device:'Device reference', purpose:'Purpose', location:'Recording location',
    start:'Start (GST)', end:'End (GST)', filename:'Stored filename', storage:'Storage location',
    time:'Storage transfer time (GST)', storedBy:'Transferred by'
  }}
};

const ref=id=>id?'EX-'+String(id).padStart(3,'0'):'Case';
export async function createPdf({name,attempt,caseRef,submittedAt,records}){
  const doc=new PDFDocument({size:'A4',margin:42,info:{Title:'PEMS assessment evidence · '+attempt}});
  const result=new Promise((resolve,reject)=>{
    const chunks=[];
    doc.on('data',chunk=>chunks.push(chunk));
    doc.on('end',()=>resolve(Buffer.concat(chunks)));
    doc.on('error',reject);
  });
  doc.font(fileURLToPath(new URL('./assets/DejaVuSans.ttf',import.meta.url)));
  function title(text,size){
    doc.fontSize(size).fillColor('#142e48').text(text).moveDown(.3);
  }
  function field(label,value){
    if(value)doc.fontSize(9).fillColor('#18283a').text(label+': '+value);
  }
  function room(){
    if(doc.y>doc.page.height-doc.page.margins.bottom-110)doc.addPage();
  }
  title('Police Evidence Management System',19);
  title('Practical assessment evidence',13);
  field('Candidate',name);
  field('Attempt reference',attempt);
  field('Case reference',caseRef);
  field('Submitted at (UTC)',submittedAt);
  doc.moveDown();
  for(const [kind,form] of Object.entries(forms)){
    room();
    title(form.title,13);
    const rows=records.filter(record=>record.kind===kind);
    if(kind==='transfer')rows.sort((a,b)=>a.exhibit-b.exhibit||a.time.localeCompare(b.time)||a.id-b.id);
    if(!rows.length)field('Records','None entered');
    for(const row of rows){
      room();
      title(kind==='exhibit'?ref(row.id):ref(row.exhibit),10);
      for(const [key,label] of Object.entries(form.fields))field(label,row[key]);
      doc.moveDown(.6);
    }
    doc.moveDown(.6);
    if(kind==='exhibit'&&rows.length){
      room();
      title('Exhibit labels',13);
      for(const row of rows){
        room();
        title(caseRef+' · '+ref(row.id),10);
        for(const key of ['description','location','time','recoveredBy','packageRef','seal'])field(form.fields[key],row[key]);
        doc.moveDown(.6);
      }
    }
  }
  doc.end();
  return result;
}
